import { spawn } from "child_process";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  collectDiagnostics,
  formatDiagnostics,
  type SystemDiagnostics,
} from "./collector.ts";

export interface BugReportInput {
  issueDescription: string;
  expectedBehavior?: string;
  stepsToReproduce?: string;
  includeLogs?: boolean;
}

export interface BugReportResult {
  title: string;
  body: string;
  success: boolean;
  error?: string;
}

export async function generateBugReport(
  input: BugReportInput
): Promise<BugReportResult> {
  try {
    const diagnostics = await collectDiagnostics({
      includeLogs: input.includeLogs !== false,
    });

    const formattedDiagnostics = formatDiagnostics(diagnostics);

    const prompt = buildPrompt(
      formattedDiagnostics,
      input.issueDescription,
      input.expectedBehavior,
      input.stepsToReproduce
    );

    const generatedMarkdown = await runCodexExec(prompt);

    const titleMatch = generatedMarkdown.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1] : "Bug Report";

    return {
      title,
      body: generatedMarkdown,
      success: true,
    };
  } catch (error) {
    console.error("Codex CLI generation failed, using template fallback:", error);
    return generateTemplateFallback(input);
  }
}

async function runCodexExec(prompt: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codex-mem-bug-report-"));
  const outputPath = join(dir, "last-message.md");
  try {
    const args = [
      "exec",
      "--json",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--output-last-message",
      outputPath,
      "-",
    ];

    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.env.CODEX_CODE_PATH || "codex", args, {
        stdio: ["pipe", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", chunk => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", code => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`codex exec failed with exit code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
        }
      });
      child.stdin.end(prompt);
    });

    return (await readFile(outputPath, "utf-8")).trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function buildPrompt(
  diagnostics: string,
  issueDescription: string,
  expectedBehavior?: string,
  stepsToReproduce?: string
): string {
  let prompt = `You are a GitHub issue formatter. Given system diagnostics and a user's bug description, create a well-structured GitHub issue for the codex-mem repository.

SYSTEM DIAGNOSTICS:
${diagnostics}

USER DESCRIPTION:
${issueDescription}
`;

  if (expectedBehavior) {
    prompt += `\nEXPECTED BEHAVIOR:
${expectedBehavior}
`;
  }

  if (stepsToReproduce) {
    prompt += `\nSTEPS TO REPRODUCE:
${stepsToReproduce}
`;
  }

  prompt += `

IMPORTANT: If any part of the user's description is in a language other than English, translate it to English while preserving technical accuracy and meaning.

Create a GitHub issue with:
1. Clear, descriptive title (max 80 chars) in English - start with a single # heading
2. Problem statement summarizing the issue in English
3. Environment section (versions, platform) from the diagnostics
4. Steps to reproduce (if provided) in English
5. Expected vs actual behavior in English
6. Relevant logs (formatted as code blocks) if present in diagnostics
7. Any additional context that would help diagnose the issue

Format the output as valid GitHub Markdown. Make sure the title is a single # heading at the very top.
Do NOT add meta-commentary like "Here's a formatted issue" - just output the raw markdown.
All content must be in English for the GitHub issue.
`;

  return prompt;
}

async function generateTemplateFallback(
  input: BugReportInput
): Promise<BugReportResult> {
  const diagnostics = await collectDiagnostics({
    includeLogs: input.includeLogs !== false,
  });
  const formattedDiagnostics = formatDiagnostics(diagnostics);

  let body = `# Bug Report\n\n`;
  body += `## Description\n\n`;
  body += `${input.issueDescription}\n\n`;

  if (input.expectedBehavior) {
    body += `## Expected Behavior\n\n`;
    body += `${input.expectedBehavior}\n\n`;
  }

  if (input.stepsToReproduce) {
    body += `## Steps to Reproduce\n\n`;
    body += `${input.stepsToReproduce}\n\n`;
  }

  body += formattedDiagnostics;

  return {
    title: "Bug Report",
    body,
    success: true,
  };
}
