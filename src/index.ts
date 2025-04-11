#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import * as os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";

const gitHubLabels = [
  "Bounty",
  "Bug",
  "dependencies",
  "documentation",
  "Enhancement",
  "Good First Issue",
  "Help Wanted",
  "In Progress",
  "Invalid",
  "javascript",
  "Question",
  "Reported by Cline",
  "RFR",
  "Triaged",
  "Won't/Unable to Fix",
];

const execAsync = promisify(exec);

// Helper function to escape strings for shell commands
function escapeShellArg(arg: string): string {
  // More robust escaping might be needed depending on expected input
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Function to get API metadata from task_metadata.json in the highest numbered task directory
 * across all possible IDE paths, handling different OS paths
 */
async function getApiMetadata(): Promise<{
  apiProvider: string;
  modelName: string;
  ideUsed: string;
}> {
  const platform = os.platform();
  const homeDir = os.homedir();
  const ideApps = ["Code", "Cursor", "Windsurf"];
  let possiblePaths: string[] = [];

  // Determine paths based on operating system
  if (platform === "win32") {
    // Windows paths: AppData\Roaming\{app}\User\globalStorage\...
    const appData = process.env.APPDATA;
    if (!appData) {
      throw new Error("APPDATA environment variable is not defined");
    }

    possiblePaths = ideApps.map((app) =>
      path.join(
        appData,
        app,
        "User",
        "globalStorage",
        "saoudrizwan.claude-dev",
        "tasks"
      )
    );
  } else if (platform === "darwin") {
    // macOS paths: Library/Application Support/{app}/User/globalStorage/...
    possiblePaths = ideApps.map((app) =>
      path.join(
        homeDir,
        "Library",
        "Application Support",
        app,
        "User",
        "globalStorage",
        "saoudrizwan.claude-dev",
        "tasks"
      )
    );
  } else if (platform === "linux") {
    // Linux paths: .config/{app}/User/globalStorage/... (common pattern)
    possiblePaths = ideApps.map((app) =>
      path.join(
        homeDir,
        ".config",
        app,
        "User",
        "globalStorage",
        "saoudrizwan.claude-dev",
        "tasks"
      )
    );
  } else {
    throw new Error(`Unsupported operating system: ${platform}`);
  }

  let highestOverallTaskNumber = -1;
  let finalBasePath = null;

  // Find the IDE path with the highest task number
  for (const basePath of possiblePaths) {
    try {
      await fs.promises.stat(basePath); // Check if path exists

      // Read all subdirectories
      const entries = await fs.promises.readdir(basePath, {
        withFileTypes: true,
      });
      const numericDirs = entries
        .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
        .map((entry) => parseInt(entry.name, 10));

      if (numericDirs.length > 0) {
        const currentHighestTaskNumber = Math.max(...numericDirs);

        if (currentHighestTaskNumber > highestOverallTaskNumber) {
          highestOverallTaskNumber = currentHighestTaskNumber;
          finalBasePath = basePath;
        }
      }
    } catch (error) {
      // Path doesn't exist or can't be accessed, continue to next path
      continue;
    }
  }

  if (finalBasePath === null) {
    throw new Error("Could not find any valid task directories");
  }

  // Extract IDE name from the path
  let ideUsed = "Unknown";
  const ideNames = ["Code", "Cursor", "Windsurf"];
  for (const ideName of ideNames) {
    if (finalBasePath.includes(ideName)) {
      ideUsed = ideName;
      break;
    }
  }

  // Get the task_metadata.json file
  const metadataFilePath = path.join(
    finalBasePath,
    highestOverallTaskNumber.toString(),
    "task_metadata.json"
  );

  try {
    const metadataContent = await fs.promises.readFile(
      metadataFilePath,
      "utf-8"
    );
    const metadata = JSON.parse(metadataContent);

    if (
      !metadata.model_usage ||
      !Array.isArray(metadata.model_usage) ||
      metadata.model_usage.length === 0
    ) {
      throw new Error(
        "Invalid metadata format: model_usage array missing or empty"
      );
    }

    // Find the latest entry by timestamp
    interface ModelUsageEntry {
      ts: number;
      model_id: string;
      model_provider_id: string;
      mode?: string;
    }

    const latestEntry = metadata.model_usage.reduce(
      (latest: ModelUsageEntry | null, current: ModelUsageEntry) => {
        return !latest || current.ts > latest.ts ? current : latest;
      },
      null
    );

    if (
      !latestEntry ||
      !latestEntry.model_provider_id ||
      !latestEntry.model_id
    ) {
      throw new Error(
        "Invalid metadata format: latest entry missing required fields"
      );
    }

    return {
      apiProvider: latestEntry.model_provider_id,
      modelName: latestEntry.model_id,
      ideUsed: ideUsed,
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Error reading or parsing metadata file: ${errorMessage}`);
  }
}

// Input validation function
const isValidReportArgs = (
  args: any
): args is {
  description: string;
  title: string;
  labels?: string[];
} => {
  return (
    typeof args === "object" &&
    args !== null &&
    typeof args.description === "string" &&
    typeof args.title === "string" &&
    // Check if labels is undefined or an array of strings
    (args.labels === undefined ||
      (Array.isArray(args.labels) &&
        args.labels.every((l: any) => typeof l === "string")))
  );
};

const inputSchema = {
  type: "object",
  properties: {
    description: {
      type: "string",
      description: "The user's detailed description of the problem.",
    },
    title: {
      type: "string",
      description: "The title for the GitHub issue.",
    },
    labels: {
      type: "array",
      items: {
        type: "string",
        enum: gitHubLabels,
      },
      description: "Optional: Array of allowed labels to apply to the issue.",
    },
  },
  required: ["description", "title"],
};

class ClineIssueReporterServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: "cline-issue-reporter",
        version: "0.1.0",
      },
      {
        capabilities: {
          resources: {},
          tools: {},
        },
      }
    );

    this.setupToolHandlers();

    // Error handling
    this.server.onerror = (error) => console.error("[MCP Error]", error);
    process.on("SIGINT", async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "preview_cline_issue",
          description:
            "Previews how an issue would look when reported to GitHub. Gathers OS info and Cline version automatically but does not submit the issue. This tool is always called first to preview the issue before reporting it.",
          inputSchema: inputSchema,
        },
        {
          name: "report_cline_issue",
          description:
            "Reports an issue to a GitHub repository using the locally authenticated GitHub CLI (`gh`). Gathers OS info and Cline version automatically.",
          inputSchema: inputSchema,
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      // Check if the requested tool is valid
      if (
        request.params.name !== "report_cline_issue" &&
        request.params.name !== "preview_cline_issue"
      ) {
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${request.params.name}`
        );
      }

      if (!isValidReportArgs(request.params.arguments)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid arguments for ${request.params.name}. Requires: description (string), title (string), labels (string[], optional).`
        );
      }

      // Extract arguments
      const { description, title, labels } = request.params.arguments;
      const repo = "cline/cline"; // Hardcoded repository

      try {
        // 1. Get OS Info
        const osPlatform = os.platform();
        const osRelease = os.release();

        // Get API info from metadata
        let apiProvider, modelName, ideUsed;
        try {
          const apiMetadata = await getApiMetadata();
          apiProvider = apiMetadata.apiProvider;
          modelName = apiMetadata.modelName;
          ideUsed = apiMetadata.ideUsed;
        } catch (error: unknown) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          return {
            content: [
              {
                type: "text",
                text: `Error retrieving API metadata: ${errorMessage}. Please try again or provide apiProvider and modelName manually.`,
              },
            ],
            isError: true,
          };
        }

        // 2. Get Cline Version - using a cross-platform approach
        let clineVersion = "unknown";
        try {
          const platform = os.platform();
          const isWindows = platform === "win32";
          const searchCmd = isWindows ? "findstr" : "grep";
          const ides = ["code", "cursor", "windsurf"]; // IDEs to try

          // Try each IDE until we get a version
          for (const ide of ides) {
            try {
              const command = `${ide} --list-extensions --show-versions | ${searchCmd} saoudrizwan.claude-dev`;
              const { stdout } = await execAsync(command);

              const match = stdout.match(/saoudrizwan\.claude-dev@([\d.]+)/);
              if (match && match[1]) {
                clineVersion = match[1];
                break; // Found a version, exit the loop
              }
            } catch (e) {
              // This IDE command failed, continue to next one
              continue;
            }
          }

          if (clineVersion === "unknown") {
            console.warn("Could not determine Cline version from any IDE");
          }
        } catch (error) {
          console.error("Error getting Cline version:", error);
          // Proceed with 'unknown' version
        }

        // 3. Format Issue Body
        const formattedBody = `**Reported by:** User via Cline Issue Reporter MCP
**Cline Version:** ${clineVersion}
**IDE:** ${ideUsed}
**OS:** ${osPlatform} (${osRelease})
**API Provider:** ${apiProvider}
**Model:** ${modelName}

---

**Description:**
${description}`;

        // If this is a preview request, return the formatted data without executing gh
        if (request.params.name === "preview_cline_issue") {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    title: title,
                    body: formattedBody,
                    labels: labels || [],
                    repository: repo,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        // 4. Construct gh Command (only for report_cline_issue)
        let ghCommand = `gh issue create --repo ${escapeShellArg(
          repo
        )} --title ${escapeShellArg(title)} --body ${escapeShellArg(
          formattedBody
        )}`;

        // Add labels dynamically if provided and not empty
        if (labels && labels.length > 0) {
          // Ensure labels are escaped and joined correctly
          const labelString = labels.map(escapeShellArg).join(",");
          ghCommand += ` --label ${labelString}`;
        }

        // 5. Execute gh Command
        console.log(`Executing: ${ghCommand}`); // Log the command for debugging
        const { stdout: ghStdout, stderr: ghStderr } =
          await execAsync(ghCommand);

        if (ghStderr) {
          // gh often prints success messages to stderr, check stdout first
          if (ghStdout) {
            console.log("gh command stdout:", ghStdout);
          } else {
            // If no stdout, treat stderr as an error
            console.error("gh command stderr:", ghStderr);
            // Return stderr as error content, but don't throw McpError yet
            return {
              content: [
                { type: "text", text: `GitHub CLI Error: ${ghStderr}` },
              ],
              isError: true,
            };
          }
        }

        // 6. Return Result (usually the URL of the created issue from stdout)
        return {
          content: [
            {
              type: "text",
              text:
                ghStdout || "Issue reported successfully (no stdout from gh).",
            },
          ],
        };
      } catch (error: any) {
        console.error("Error executing report_cline_issue:", error);
        // Check if it's an error from execAsync (e.g., command not found)
        if (error.stderr || error.stdout || error.message) {
          const errorMessage = error.stderr || error.stdout || error.message;
          // Check for common gh errors
          if (
            errorMessage.includes("gh not found") ||
            errorMessage.includes("command not found")
          ) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: GitHub CLI ('gh') not found. Please install it and authenticate (`gh auth login`).",
                },
              ],
              isError: true,
            };
          }
          if (errorMessage.includes("authentication required")) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: GitHub CLI authentication required. Please run `gh auth login`.",
                },
              ],
              isError: true,
            };
          }
          // Generic execution error
          return {
            content: [
              {
                type: "text",
                text: `Command execution failed: ${errorMessage}`,
              },
            ],
            isError: true,
          };
        }
        // Otherwise, rethrow as internal server error
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to report issue: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Cline Issue Reporter MCP server running on stdio");
  }
}

const server = new ClineIssueReporterServer();
server.run().catch(console.error);
