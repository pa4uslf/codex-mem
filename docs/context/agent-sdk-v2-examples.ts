import { spawn } from 'child_process';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

async function codexExec(prompt: string, model = 'gpt-5'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-mem-example-'));
  const outputPath = join(dir, 'last-message.txt');
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('codex', [
        'exec',
        '--json',
        '--sandbox',
        'read-only',
        '--skip-git-repo-check',
        '--output-last-message',
        outputPath,
        '--model',
        model,
        '-',
      ], {
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', chunk => {
        stderr += chunk.toString();
      });
      child.on('error', reject);
      child.on('close', code => {
        code === 0
          ? resolve()
          : reject(new Error(`codex exec failed with exit code ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
      });
      child.stdin.end(prompt);
    });
    return (await readFile(outputPath, 'utf-8')).trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  const result = await codexExec('What is the capital of France? One word.');
  console.log(result);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
