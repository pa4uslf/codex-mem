import { describe, it, expect, mock, afterEach, beforeEach } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import path, { join } from 'path';
import { tmpdir } from 'os';

mock.module('../../src/utils/logger.js', () => ({
  logger: {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
    formatTool: (toolName: string, toolInput?: any) => toolInput ? `${toolName}(...)` : toolName,
  },
}));

mock.module('../../src/shared/worker-utils.js', () => ({
  getWorkerPort: () => 37777,
  getWorkerHost: () => '127.0.0.1',
  workerHttpRequest: (apiPath: string, options?: any) => {
    const url = `http://127.0.0.1:37777${apiPath}`;
    return globalThis.fetch(url, {
      method: options?.method ?? 'GET',
      headers: options?.headers,
      body: options?.body,
    });
  },
  clearPortCache: () => {},
  ensureWorkerRunning: () => Promise.resolve(true),
  fetchWithTimeout: (url: string, init: any, timeoutMs: number) => globalThis.fetch(url, init),
  buildWorkerUrl: (apiPath: string) => `http://127.0.0.1:37777${apiPath}`,
}));

import {
  replaceTaggedContent,
  formatTimelineForCodexMd,
  writeCodexMdToFolder,
  updateFolderCodexMdFiles,
  getTargetFilename
} from '../../src/utils/codex-md-utils.js';

let tempDir: string;
const originalFetch = global.fetch;

beforeEach(() => {
  tempDir = join(tmpdir(), `test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  mock.restore();
  global.fetch = originalFetch;
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

describe('replaceTaggedContent', () => {
  it('should wrap new content in tags when existing content is empty', () => {
    const result = replaceTaggedContent('', 'New content here');

    expect(result).toBe('<codex-mem-context>\nNew content here\n</codex-mem-context>');
  });

  it('should replace only tagged section when existing content has tags', () => {
    const existingContent = 'User content before\n<codex-mem-context>\nOld generated content\n</codex-mem-context>\nUser content after';
    const newContent = 'New generated content';

    const result = replaceTaggedContent(existingContent, newContent);

    expect(result).toBe('User content before\n<codex-mem-context>\nNew generated content\n</codex-mem-context>\nUser content after');
  });

  it('should append tagged content with separator when no tags exist in existing content', () => {
    const existingContent = 'User written documentation';
    const newContent = 'Generated timeline';

    const result = replaceTaggedContent(existingContent, newContent);

    expect(result).toBe('User written documentation\n\n<codex-mem-context>\nGenerated timeline\n</codex-mem-context>');
  });

  it('should append when only opening tag exists (no matching end tag)', () => {
    const existingContent = 'Some content\n<codex-mem-context>\nIncomplete tag section';
    const newContent = 'New content';

    const result = replaceTaggedContent(existingContent, newContent);

    expect(result).toBe('Some content\n<codex-mem-context>\nIncomplete tag section\n\n<codex-mem-context>\nNew content\n</codex-mem-context>');
  });

  it('should append when only closing tag exists (no matching start tag)', () => {
    const existingContent = 'Some content\n</codex-mem-context>\nMore content';
    const newContent = 'New content';

    const result = replaceTaggedContent(existingContent, newContent);

    expect(result).toBe('Some content\n</codex-mem-context>\nMore content\n\n<codex-mem-context>\nNew content\n</codex-mem-context>');
  });

  it('should preserve newlines in new content', () => {
    const existingContent = '<codex-mem-context>\nOld content\n</codex-mem-context>';
    const newContent = 'Line 1\nLine 2\nLine 3';

    const result = replaceTaggedContent(existingContent, newContent);

    expect(result).toBe('<codex-mem-context>\nLine 1\nLine 2\nLine 3\n</codex-mem-context>');
  });
});

describe('formatTimelineForCodexMd', () => {
  it('should return empty string for empty input', () => {
    const result = formatTimelineForCodexMd('');

    expect(result).toBe('');
  });

  it('should return empty string when no table rows exist', () => {
    const input = 'Just some plain text without table rows';

    const result = formatTimelineForCodexMd(input);

    expect(result).toBe('');
  });

  it('should parse single observation row correctly', () => {
    const input = '| #123 | 4:30 PM | 🔵 | User logged in | ~100 |';

    const result = formatTimelineForCodexMd(input);

    expect(result).toContain('#123');
    expect(result).toContain('4:30 PM');
    expect(result).toContain('🔵');
    expect(result).toContain('User logged in');
    expect(result).toContain('~100');
  });

  it('should parse ditto mark for repeated time correctly', () => {
    const input = `| #123 | 4:30 PM | 🔵 | First action | ~100 |
| #124 | ″ | 🔵 | Second action | ~150 |`;

    const result = formatTimelineForCodexMd(input);

    expect(result).toContain('#123');
    expect(result).toContain('#124');
    expect(result).toContain('4:30 PM');
    expect(result).toContain('"');
  });

  it('should parse session ID format (#S123) correctly', () => {
    const input = '| #S123 | 4:30 PM | 🟣 | Session started | ~200 |';

    const result = formatTimelineForCodexMd(input);

    expect(result).toContain('#S123');
    expect(result).toContain('4:30 PM');
    expect(result).toContain('🟣');
    expect(result).toContain('Session started');
  });
});

describe('writeCodexMdToFolder', () => {
  it('should skip non-existent folders (fix for spurious directory creation)', () => {
    const folderPath = join(tempDir, 'non-existent-folder');
    const content = '# Recent Activity\n\nTest content';

    writeCodexMdToFolder(folderPath, content);

    expect(existsSync(folderPath)).toBe(false);
    const codexMdPath = join(folderPath, 'CODEX.md');
    expect(existsSync(codexMdPath)).toBe(false);
  });

  it('should create CODEX.md in existing folder', () => {
    const folderPath = join(tempDir, 'existing-folder');
    mkdirSync(folderPath, { recursive: true });
    const content = '# Recent Activity\n\nTest content';

    writeCodexMdToFolder(folderPath, content);

    const codexMdPath = join(folderPath, 'CODEX.md');
    expect(existsSync(codexMdPath)).toBe(true);

    const fileContent = readFileSync(codexMdPath, 'utf-8');
    expect(fileContent).toContain('<codex-mem-context>');
    expect(fileContent).toContain('Test content');
    expect(fileContent).toContain('</codex-mem-context>');
  });

  it('should preserve user content outside tags', () => {
    const folderPath = join(tempDir, 'preserve-test');
    mkdirSync(folderPath, { recursive: true });

    const codexMdPath = join(folderPath, 'CODEX.md');
    const userContent = 'User-written docs\n<codex-mem-context>\nOld content\n</codex-mem-context>\nMore user docs';
    writeFileSync(codexMdPath, userContent);

    const newContent = 'New generated content';
    writeCodexMdToFolder(folderPath, newContent);

    const fileContent = readFileSync(codexMdPath, 'utf-8');
    expect(fileContent).toContain('User-written docs');
    expect(fileContent).toContain('New generated content');
    expect(fileContent).toContain('More user docs');
    expect(fileContent).not.toContain('Old content');
  });

  it('should not create nested directories (fix for spurious directory creation)', () => {
    const folderPath = join(tempDir, 'deep', 'nested', 'folder');
    const content = 'Nested content';

    writeCodexMdToFolder(folderPath, content);

    const codexMdPath = join(folderPath, 'CODEX.md');
    expect(existsSync(codexMdPath)).toBe(false);
    expect(existsSync(join(tempDir, 'deep'))).toBe(false);
  });

  it('should not leave .tmp file after write (atomic write)', () => {
    const folderPath = join(tempDir, 'atomic-test');
    mkdirSync(folderPath, { recursive: true });
    const content = 'Atomic write test';

    writeCodexMdToFolder(folderPath, content);

    const codexMdPath = join(folderPath, 'CODEX.md');
    const tempFilePath = `${codexMdPath}.tmp`;

    expect(existsSync(codexMdPath)).toBe(true);
    expect(existsSync(tempFilePath)).toBe(false);
  });
});

describe('issue #1165 - prevent CODEX.md inside .git directories', () => {
  it('should not write CODEX.md when folder is inside .git/', () => {
    const gitRefsFolder = join(tempDir, '.git', 'refs');
    mkdirSync(gitRefsFolder, { recursive: true });

    writeCodexMdToFolder(gitRefsFolder, 'Should not be written');

    const codexMdPath = join(gitRefsFolder, 'CODEX.md');
    expect(existsSync(codexMdPath)).toBe(false);
  });

  it('should not write CODEX.md when folder is .git itself', () => {
    const gitFolder = join(tempDir, '.git');
    mkdirSync(gitFolder, { recursive: true });

    writeCodexMdToFolder(gitFolder, 'Should not be written');

    const codexMdPath = join(gitFolder, 'CODEX.md');
    expect(existsSync(codexMdPath)).toBe(false);
  });

  it('should not write CODEX.md to deeply nested .git path', () => {
    const deepGitPath = join(tempDir, 'project', '.git', 'hooks');
    mkdirSync(deepGitPath, { recursive: true });

    writeCodexMdToFolder(deepGitPath, 'Should not be written');

    const codexMdPath = join(deepGitPath, 'CODEX.md');
    expect(existsSync(codexMdPath)).toBe(false);
  });

  it('should still write CODEX.md to normal folders', () => {
    const normalFolder = join(tempDir, 'src', 'git-utils');
    mkdirSync(normalFolder, { recursive: true });

    writeCodexMdToFolder(normalFolder, 'Should be written');

    const codexMdPath = join(normalFolder, 'CODEX.md');
    expect(existsSync(codexMdPath)).toBe(true);
  });
});

describe('updateFolderCodexMdFiles', () => {
  it('should skip when filePaths is empty', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    await updateFolderCodexMdFiles([], 'test-project', 37777);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should fetch timeline and write CODEX.md', async () => {
    const folderPath = join(tempDir, 'api-test');
    mkdirSync(folderPath, { recursive: true }); 
    const filePath = join(folderPath, 'test.ts');

    const apiResponse = {
      content: [{
        text: '| #123 | 4:30 PM | 🔵 | Test observation | ~100 |'
      }]
    };

    global.fetch = mock(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(apiResponse)
    } as Response));

    await updateFolderCodexMdFiles([filePath], 'test-project', 37777);

    const codexMdPath = join(folderPath, 'CODEX.md');
    expect(existsSync(codexMdPath)).toBe(true);

    const content = readFileSync(codexMdPath, 'utf-8');
    expect(content).toContain('Recent Activity');
    expect(content).toContain('#123');
    expect(content).toContain('Test observation');
  });

  it('should deduplicate folders from multiple files', async () => {
    const folderPath = join(tempDir, 'dedup-test');
    const file1 = join(folderPath, 'file1.ts');
    const file2 = join(folderPath, 'file2.ts');

    const apiResponse = {
      content: [{
        text: '| #123 | 4:30 PM | 🔵 | Test | ~100 |'
      }]
    };

    const fetchMock = mock(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(apiResponse)
    } as Response));
    global.fetch = fetchMock;

    await updateFolderCodexMdFiles([file1, file2], 'test-project', 37777);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should handle API errors gracefully (404 response)', async () => {
    const folderPath = join(tempDir, 'error-test');
    const filePath = join(folderPath, 'test.ts');

    global.fetch = mock(() => Promise.resolve({
      ok: false,
      status: 404
    } as Response));

    await expect(updateFolderCodexMdFiles([filePath], 'test-project', 37777)).resolves.toBeUndefined();

    const codexMdPath = join(folderPath, 'CODEX.md');
    expect(existsSync(codexMdPath)).toBe(false);
  });

  it('should handle network errors gracefully (fetch throws)', async () => {
    const folderPath = join(tempDir, 'network-error-test');
    const filePath = join(folderPath, 'test.ts');

    global.fetch = mock(() => Promise.reject(new Error('Network error')));

    await expect(updateFolderCodexMdFiles([filePath], 'test-project', 37777)).resolves.toBeUndefined();

    const codexMdPath = join(folderPath, 'CODEX.md');
    expect(existsSync(codexMdPath)).toBe(false);
  });

  it('should resolve relative paths using projectRoot', async () => {
    const apiResponse = {
      content: [{
        text: '| #123 | 4:30 PM | 🔵 | Test observation | ~100 |'
      }]
    };

    const fetchMock = mock(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(apiResponse)
    } as Response));
    global.fetch = fetchMock;

    await updateFolderCodexMdFiles(
      ['src/utils/file.ts'],  // relative path
      'test-project',
      37777,
      '/home/user/my-project'  
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const callUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    expect(callUrl).toContain(encodeURIComponent('/home/user/my-project/src/utils'));
  });

  it('should accept absolute paths within projectRoot and use them directly', async () => {
    const folderPath = join(tempDir, 'absolute-path-test');
    const filePath = join(folderPath, 'file.ts');

    const apiResponse = {
      content: [{
        text: '| #123 | 4:30 PM | 🔵 | Test observation | ~100 |'
      }]
    };

    const fetchMock = mock(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(apiResponse)
    } as Response));
    global.fetch = fetchMock;

    await updateFolderCodexMdFiles(
      [filePath],  // absolute path within tempDir
      'test-project',
      37777,
      tempDir  
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const callUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    expect(callUrl).toContain(encodeURIComponent(folderPath));
  });

  it('should work without projectRoot for backward compatibility', async () => {
    const folderPath = join(tempDir, 'backward-compat-test');
    const filePath = join(folderPath, 'file.ts');

    const apiResponse = {
      content: [{
        text: '| #123 | 4:30 PM | 🔵 | Test observation | ~100 |'
      }]
    };

    const fetchMock = mock(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(apiResponse)
    } as Response));
    global.fetch = fetchMock;

    await updateFolderCodexMdFiles(
      [filePath],  // absolute path
      'test-project',
      37777
      // No projectRoot - backward compatibility
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const callUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    expect(callUrl).toContain(encodeURIComponent(folderPath));
  });

  it('should handle projectRoot with trailing slash correctly', async () => {
    const apiResponse = {
      content: [{
        text: '| #123 | 4:30 PM | 🔵 | Test observation | ~100 |'
      }]
    };

    const fetchMock = mock(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(apiResponse)
    } as Response));
    global.fetch = fetchMock;

    await updateFolderCodexMdFiles(
      ['src/utils/file.ts'],
      'test-project',
      37777,
      '/home/user/my-project/'  
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const callUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    expect(callUrl).toContain(encodeURIComponent('/home/user/my-project/src/utils'));
    expect(callUrl.replace('http://', '')).not.toContain('//');
  });

  it('should write CODEX.md to resolved projectRoot path', async () => {
    const subfolderPath = join(tempDir, 'project-root-write-test', 'src', 'utils');
    mkdirSync(subfolderPath, { recursive: true }); 

    const apiResponse = {
      content: [{
        text: '| #456 | 5:00 PM | 🔵 | Written to correct path | ~200 |'
      }]
    };

    global.fetch = mock(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(apiResponse)
    } as Response));

    await updateFolderCodexMdFiles(
      ['src/utils/file.ts'],
      'test-project',
      37777,
      join(tempDir, 'project-root-write-test')
    );

    const codexMdPath = join(subfolderPath, 'CODEX.md');
    expect(existsSync(codexMdPath)).toBe(true);

    const content = readFileSync(codexMdPath, 'utf-8');
    expect(content).toContain('Written to correct path');
    expect(content).toContain('#456');
  });

  it('should deduplicate relative paths from same folder with projectRoot', async () => {
    const apiResponse = {
      content: [{
        text: '| #123 | 4:30 PM | 🔵 | Test | ~100 |'
      }]
    };

    const fetchMock = mock(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(apiResponse)
    } as Response));
    global.fetch = fetchMock;

    await updateFolderCodexMdFiles(
      ['src/utils/file1.ts', 'src/utils/file2.ts', 'src/utils/file3.ts'],
      'test-project',
      37777,
      '/home/user/project'
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const callUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    expect(callUrl).toContain(encodeURIComponent('/home/user/project/src/utils'));
  });

  it('should handle empty string paths gracefully with projectRoot', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    await updateFolderCodexMdFiles(
      ['', 'src/file.ts', ''],  // includes empty strings
      'test-project',
      37777,
      '/home/user/project'
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const callUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    expect(callUrl).toContain(encodeURIComponent('/home/user/project/src'));
  });
});

describe('path validation in updateFolderCodexMdFiles', () => {
  it('should reject tilde paths', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    await updateFolderCodexMdFiles(
      ['~/.codex-mem/logs/worker.log'],
      'test-project',
      37777,
      tempDir
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should reject URLs', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    await updateFolderCodexMdFiles(
      ['https://example.com/file.ts'],
      'test-project',
      37777,
      tempDir
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should reject paths with spaces', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    await updateFolderCodexMdFiles(
      ['PR #610 on thedotmack/CODEX.md'],
      'test-project',
      37777,
      tempDir
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should reject paths with hash symbols', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    await updateFolderCodexMdFiles(
      ['issue#123/file.ts'],
      'test-project',
      37777,
      tempDir
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should reject path traversal outside project', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    await updateFolderCodexMdFiles(
      ['../../../etc/passwd'],
      'test-project',
      37777,
      tempDir
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should reject absolute paths outside project root', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    await updateFolderCodexMdFiles(
      ['/etc/passwd'],
      'test-project',
      37777,
      tempDir
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should accept absolute paths within project root', async () => {
    const apiResponse = {
      content: [{ text: '| #123 | 4:30 PM | 🔵 | Test | ~100 |' }]
    };
    const fetchMock = mock(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(apiResponse)
    } as Response));
    global.fetch = fetchMock;

    const absolutePathInProject = path.join(tempDir, 'src', 'utils', 'file.ts');

    await updateFolderCodexMdFiles(
      [absolutePathInProject],
      'test-project',
      37777,
      tempDir
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should accept absolute paths when no projectRoot is provided', async () => {
    const apiResponse = {
      content: [{ text: '| #123 | 4:30 PM | 🔵 | Test | ~100 |' }]
    };
    const fetchMock = mock(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(apiResponse)
    } as Response));
    global.fetch = fetchMock;

    await updateFolderCodexMdFiles(
      ['/home/user/valid/file.ts'],
      'test-project',
      37777
      // No projectRoot provided
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should accept valid relative paths', async () => {
    const apiResponse = {
      content: [{ text: '| #123 | 4:30 PM | 🔵 | Test | ~100 |' }]
    };
    const fetchMock = mock(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(apiResponse)
    } as Response));
    global.fetch = fetchMock;

    await updateFolderCodexMdFiles(
      ['src/utils/logger.ts'],
      'test-project',
      37777,
      tempDir
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('issue #814 - reject consecutive duplicate path segments', () => {
  it('should reject paths with consecutive duplicate segments like frontend/frontend/', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    await updateFolderCodexMdFiles(
      ['frontend/src/file.ts'],
      'test-project',
      37777,
      path.join(tempDir, 'frontend')  
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should reject paths with consecutive duplicate segments like src/src/', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    await updateFolderCodexMdFiles(
      ['src/components/file.ts'],
      'test-project',
      37777,
      path.join(tempDir, 'src')  
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should allow paths with non-consecutive duplicate segments', async () => {
    const apiResponse = {
      content: [{ text: '| #123 | 4:30 PM | 🔵 | Test | ~100 |' }]
    };
    const fetchMock = mock(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(apiResponse)
    } as Response));
    global.fetch = fetchMock;

    await updateFolderCodexMdFiles(
      ['src/components/src/utils/file.ts'],
      'test-project',
      37777,
      tempDir
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('issue #859 - skip folders with active CODEX.md', () => {
  it('should skip folder when CODEX.md was read in observation', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    await updateFolderCodexMdFiles(
      ['/project/src/utils/CODEX.md'],
      'test-project',
      37777,
      '/project'
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should skip folder when CODEX.md was modified in observation', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    await updateFolderCodexMdFiles(
      ['/project/src/CODEX.md'],
      'test-project',
      37777,
      '/project'
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should process other folders even when one has active CODEX.md', async () => {
    const apiResponse = {
      content: [{ text: '| #123 | 4:30 PM | 🔵 | Test | ~100 |' }]
    };
    const fetchMock = mock(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(apiResponse)
    } as Response));
    global.fetch = fetchMock;

    await updateFolderCodexMdFiles(
      [
        '/project/src/utils/CODEX.md',  // Should skip /project/src/utils
        '/project/src/services/api.ts'   
      ],
      'test-project',
      37777,
      '/project'
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const callUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    expect(callUrl).toContain(encodeURIComponent('/project/src/services'));
    expect(callUrl).not.toContain(encodeURIComponent('/project/src/utils'));
  });

  it('should handle relative CODEX.md paths with projectRoot', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    await updateFolderCodexMdFiles(
      ['src/components/CODEX.md'],
      'test-project',
      37777,
      '/project'
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should skip only the specific folder containing active CODEX.md', async () => {
    const apiResponse = {
      content: [{ text: '| #123 | 4:30 PM | 🔵 | Test | ~100 |' }]
    };
    const fetchMock = mock(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(apiResponse)
    } as Response));
    global.fetch = fetchMock;

    await updateFolderCodexMdFiles(
      [
        '/project/src/a/CODEX.md',
        '/project/src/b/CODEX.md',
        '/project/src/c/file.ts'
      ],
      'test-project',
      37777,
      '/project'
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const callUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    expect(callUrl).toContain(encodeURIComponent('/project/src/c'));
  });

  it('should still exclude project root even when CODEX.md filter would allow it', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    const projectRoot = join(tempDir, 'git-project');
    const gitDir = join(projectRoot, '.git');
    mkdirSync(gitDir, { recursive: true });

    await updateFolderCodexMdFiles(
      [join(projectRoot, 'file.ts')],
      'test-project',
      37777,
      projectRoot
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('issue #912 - skip unsafe directories for CODEX.md generation', () => {
  it('should skip node_modules directories', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    await updateFolderCodexMdFiles(
      ['node_modules/lodash/index.js'],
      'test-project',
      37777,
      tempDir
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should skip .git directories', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    await updateFolderCodexMdFiles(
      ['.git/refs/heads/main'],
      'test-project',
      37777,
      tempDir
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should skip Android res/ directories', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    await updateFolderCodexMdFiles(
      ['app/src/main/res/layout/activity_main.xml'],
      'test-project',
      37777,
      tempDir
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should skip build/ directories', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    await updateFolderCodexMdFiles(
      ['build/outputs/apk/debug/app-debug.apk'],
      'test-project',
      37777,
      tempDir
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should skip __pycache__/ directories', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    await updateFolderCodexMdFiles(
      ['src/__pycache__/module.cpython-311.pyc'],
      'test-project',
      37777,
      tempDir
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should allow safe directories like src/', async () => {
    const apiResponse = {
      content: [{ text: '| #123 | 4:30 PM | 🔵 | Test | ~100 |' }]
    };
    const fetchMock = mock(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(apiResponse)
    } as Response));
    global.fetch = fetchMock;

    await updateFolderCodexMdFiles(
      ['src/utils/file.ts'],
      'test-project',
      37777,
      tempDir
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should skip deeply nested unsafe directories', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    await updateFolderCodexMdFiles(
      ['packages/frontend/node_modules/react/index.js'],
      'test-project',
      37777,
      tempDir
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('getTargetFilename', () => {
  it('should return CODEX.md by default', () => {
    const settings = { CODEX_MEM_FOLDER_USE_LOCAL_MD: 'false' } as any;
    expect(getTargetFilename(settings)).toBe('CODEX.md');
  });

  it('should return CODEX.local.md when USE_LOCAL_MD is true', () => {
    const settings = { CODEX_MEM_FOLDER_USE_LOCAL_MD: 'true' } as any;
    expect(getTargetFilename(settings)).toBe('CODEX.local.md');
  });

  it('should return CODEX.md when USE_LOCAL_MD is undefined', () => {
    const settings = {} as any;
    expect(getTargetFilename(settings)).toBe('CODEX.md');
  });
});

describe('CODEX.local.md support', () => {
  it('should write CODEX.local.md when targetFilename is specified', () => {
    const folderPath = join(tempDir, 'local-md-test');
    mkdirSync(folderPath, { recursive: true });
    const content = '# Recent Activity\n\nTest content';

    writeCodexMdToFolder(folderPath, content, 'CODEX.local.md');

    const localMdPath = join(folderPath, 'CODEX.local.md');
    const regularMdPath = join(folderPath, 'CODEX.md');

    expect(existsSync(localMdPath)).toBe(true);
    expect(existsSync(regularMdPath)).toBe(false);

    const fileContent = readFileSync(localMdPath, 'utf-8');
    expect(fileContent).toContain('<codex-mem-context>');
    expect(fileContent).toContain('Test content');
    expect(fileContent).toContain('</codex-mem-context>');
  });

  it('should preserve user content in CODEX.local.md outside tags', () => {
    const folderPath = join(tempDir, 'local-preserve-test');
    mkdirSync(folderPath, { recursive: true });

    const localMdPath = join(folderPath, 'CODEX.local.md');
    const userContent = 'My personal notes\n<codex-mem-context>\nOld content\n</codex-mem-context>\nMore notes';
    writeFileSync(localMdPath, userContent);

    writeCodexMdToFolder(folderPath, 'New generated content', 'CODEX.local.md');

    const fileContent = readFileSync(localMdPath, 'utf-8');
    expect(fileContent).toContain('My personal notes');
    expect(fileContent).toContain('New generated content');
    expect(fileContent).toContain('More notes');
    expect(fileContent).not.toContain('Old content');
  });

  it('should not leave .tmp file after writing CODEX.local.md', () => {
    const folderPath = join(tempDir, 'local-atomic-test');
    mkdirSync(folderPath, { recursive: true });

    writeCodexMdToFolder(folderPath, 'Atomic write test', 'CODEX.local.md');

    const localMdPath = join(folderPath, 'CODEX.local.md');
    const tempFilePath = `${localMdPath}.tmp`;

    expect(existsSync(localMdPath)).toBe(true);
    expect(existsSync(tempFilePath)).toBe(false);
  });

  it('should skip folder when CODEX.local.md was read in observation', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    await updateFolderCodexMdFiles(
      ['/project/src/utils/CODEX.local.md'],
      'test-project',
      37777,
      '/project'
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should skip folder when either CODEX.md or CODEX.local.md was read', async () => {
    const apiResponse = {
      content: [{ text: '| #123 | 4:30 PM | 🔵 | Test | ~100 |' }]
    };
    const fetchMock = mock(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(apiResponse)
    } as Response));
    global.fetch = fetchMock;

    await updateFolderCodexMdFiles(
      [
        '/project/src/a/CODEX.md',          // Skip folder a (regular)
        '/project/src/b/CODEX.local.md',    // Skip folder b (local)
        '/project/src/c/file.ts'             
      ],
      'test-project',
      37777,
      '/project'
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const callUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    expect(callUrl).toContain(encodeURIComponent('/project/src/c'));
    expect(callUrl).not.toContain(encodeURIComponent('/project/src/a'));
    expect(callUrl).not.toContain(encodeURIComponent('/project/src/b'));
  });
});
