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

// Empty schema for authenticate_github tool
const emptySchema = {
  type: "object",
  properties: {},
  required: [],
};

class ClineCommunityServer {
  private server: Server;
  private platform = os.platform();
  private homeDir = os.homedir();
  private ideApps = ["Code", "Cursor", "Windsurf"];
  private idePath = ["User", "globalStorage", "saoudrizwan.claude-dev", "tasks"];

  constructor() {
    this.server = new Server(
      {
        name: "cline-community",
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

  private async checkGhAuth() {
    let ghToken = null;
    for (const ide of this.ideApps) {
      const settingsPath = path.join(os.homedir(), 'Library', 'Application Support', ide, 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json');
      try {
        const settingsContent = await fs.promises.readFile(settingsPath, 'utf-8');
        const settings = JSON.parse(settingsContent);
        ghToken = settings?.mcpServers?.['cline-community']?.env?.GH_TOKEN;

        if (!ghToken) {
          console.warn("GH_TOKEN not found in cline_mcp_settings.json. Prompting for gh auth login...");
          // Execute gh auth login - requires user interaction in the terminal
          exec('gh auth status', (error, stdout, stderr) => {
            if (error) {
              console.error(`gh auth login failed: ${error.message}`);
              return;
            }
            if (stderr) {
              console.error(`gh auth login stderr: ${stderr}`);
              return;
            }
            console.log(`gh auth login stdout: ${stdout}`);
          });
        }
      } catch (error) {
        console.error(`Error reading cline_mcp_settings.json: ${error}`);
        console.warn("Could not check for GH_TOKEN. Please ensure gh CLI is installed and authenticated (`gh auth login`).");
      }
    }
  }

  /**
 * Function to get API metadata from task_metadata.json in the highest numbered task directory
 * across all possible IDE paths, handling different OS paths
 */
  async getApiMetadata(): Promise<{
    apiProvider: string;
    modelName: string;
    ideUsed: string;
  }> {
    let possiblePaths: string[] = [];

    // Determine paths based on operating system
    if (this.platform === "win32") {
      // Windows paths: Try to use APPDATA env var first, fall back to constructed path
      // May require Cline MCP settings for APPDATA env variable
      let appData;
      if (process.env.APPDATA) {
        appData = process.env.APPDATA;
      } else {
        appData = path.join(this.homeDir, "AppData", "Roaming");
      }
      possiblePaths = this.ideApps.map((app) => path.join(appData, app, ...this.idePath));
    } else if (this.platform === "darwin") {
      // macOS paths: Library/Application Support/{app}/User/globalStorage/...
      possiblePaths = this.ideApps.map((app) =>
        path.join(this.homeDir, "Library", "Application Support", app, ...this.idePath)
      );
    } else if (this.platform === "linux") {
      // Linux paths: .config/{app}/User/globalStorage/... (common pattern)
      possiblePaths = this.ideApps.map((app) =>
        path.join(this.homeDir, ".config", app, ...this.idePath)
      );
    } else {
      throw new Error(`Unsupported operating system: ${this.platform}`);
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
    for (const ideName of this.ideApps) {
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

  /**
   * Handle GitHub authentication
   * Checks current auth status and initiates login if needed
   */
  private async handleAuthenticateGithub(): Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }> {
    try {
      // First check if gh CLI is installed and get current auth status
      const { stdout: statusOutput, stderr: statusError } = await execAsync('gh auth status');

      // If we get here, gh is installed and we have status info
      if (statusOutput.includes("Logged in to")) {
        // User is already authenticated
        return {
          content: [
            {
              type: "text",
              text: `GitHub CLI is already authenticated: ${statusOutput.trim()}`,
            },
          ],
        };
      } else {
        // User is not authenticated, initiate login process
        // This is an interactive process that will prompt the user in their terminal
        exec('gh auth login', (error, stdout, stderr) => {
          if (error) {
            console.error(`GitHub authentication failed: ${error.message}`);
            return;
          }
          console.log(`GitHub authentication process initiated in terminal.`);
        });

        return {
          content: [
            {
              type: "text",
              text: "GitHub authentication process has been initiated in your terminal. Please complete the interactive login process there.",
            },
          ],
        };
      }
    } catch (error: any) {
      console.error("Error executing GitHub authentication:", error);

      // Check for common errors
      if (error.stderr && error.stderr.includes("command not found")) {
        return {
          content: [
            {
              type: "text",
              text: "Error: GitHub CLI ('gh') not found. Please install it first: https://cli.github.com/",
            },
          ],
          isError: true,
        };
      }

      // Generic error
      return {
        content: [
          {
            type: "text",
            text: `GitHub authentication failed: ${error.stderr || error.message || String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "authenticate_github",
          description:
            "**Call this tool if the user is not already authenticated and does not have a valid GH_TOKEN**. Initiates GitHub authentication using the `gh` CLI. Checks current status first and prompts for login if needed. This may require user interaction in the terminal. Please wait for the user to finish authentication before calling other tools.",
          inputSchema: emptySchema,
        },
        {
          name: "preview_cline_issue",
          description:
            "**Always call this tool before report_cline_issue**. Previews how an issue would look when reported to GitHub. Gathers OS info and Cline version automatically but does not submit the issue. This tool is always called first to preview the issue before reporting it.",
          inputSchema: inputSchema,
        },
        {
          name: "report_cline_issue",
          description:
            "**Call this tool after preview_cline_issue**. Reports an issue to a GitHub repository using the locally authenticated GitHub CLI (`gh`). Gathers OS info and Cline version automatically.",
          inputSchema: inputSchema,
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      // Handle authenticate_github tool separately
      if (request.params.name === "authenticate_github") {
        return await this.handleAuthenticateGithub();
      }

      // Check if the requested tool is valid for issue reporting
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
        // Get API info from metadata
        let apiProvider, modelName, ideUsed;
        try {
          const apiMetadata = await this.getApiMetadata();
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
          const isWindows = this.platform === "win32";

          if (isWindows) {
            // On Windows, try to find the extension directly in the file system
            const extensionPaths = [];

            // Add possible extension paths for different IDEs on Windows
            if (process.env.APPDATA) {
              const appData = process.env.APPDATA;
              extensionPaths.push(
                path.join(appData, "Code", "User", "extensions"),
                path.join(appData, "Cursor", "User", "extensions"),
                path.join(appData, "Windsurf", "User", "extensions")
              );
            } else {
              const appData = path.join(this.homeDir, "AppData", "Roaming");
              extensionPaths.push(
                path.join(appData, "Code", "User", "extensions"),
                path.join(appData, "Cursor", "User", "extensions"),
                path.join(appData, "Windsurf", "User", "extensions")
              );
            }

            // Also try .vscode/extensions in the home directory
            extensionPaths.push(path.join(this.homeDir, ".vscode", "extensions"));

            // Try to find the extension in each path
            for (const extPath of extensionPaths) {
              try {
                const entries = await fs.promises.readdir(extPath, { withFileTypes: true });

                // Look for directories that start with "saoudrizwan.claude-dev"
                for (const entry of entries) {
                  if (entry.isDirectory() && entry.name.startsWith("saoudrizwan.claude-dev")) {
                    // Extract version from directory name (format: saoudrizwan.claude-dev-x.y.z)
                    const versionMatch = entry.name.match(/saoudrizwan\.claude-dev-?([\d.]+)/);
                    if (versionMatch && versionMatch[1]) {
                      clineVersion = versionMatch[1];
                      break;
                    }

                    // If no version in directory name, try to read package.json
                    try {
                      const packageJsonPath = path.join(extPath, entry.name, "package.json");
                      const packageJson = JSON.parse(await fs.promises.readFile(packageJsonPath, "utf-8"));
                      if (packageJson.version) {
                        clineVersion = packageJson.version;
                        break;
                      }
                    } catch (packageError) {
                      // Failed to read package.json, continue
                      console.error("Error reading package.json:", packageError);
                    }
                  }
                }

                if (clineVersion !== "unknown") {
                  break; // Found version, exit the loop
                }
              } catch (dirError) {
                // This directory doesn't exist or can't be accessed, continue to next one
                console.error(`Error accessing ${extPath}:`, dirError);
                continue;
              }
            }
          } else {
            // For non-Windows platforms, use the original CLI approach
            const searchCmd = "grep";
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
**OS:** ${this.platform} (${os.release()})
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
                text: formattedBody,
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
        const { stdout: ghStdout, stderr: ghStderr } = await execAsync(
          ghCommand
        );

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
          `Failed to report issue: ${error instanceof Error ? error.message : String(error)
          }`
        );
      }
    });
  }

  async run() {
    await this.checkGhAuth(); // Check for GH auth on startup
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Cline Community MCP server running on stdio");
  }
}

const server = new ClineCommunityServer();
server.run().catch(console.error);
