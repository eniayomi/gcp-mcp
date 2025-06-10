import { Project, SyntaxKind } from "ts-morph";
import { createContext, runInContext } from "vm";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  CallToolRequest
} from "@modelcontextprotocol/sdk/types";
import { z } from "zod";
import { GoogleAuth } from 'google-auth-library';
import { InstancesClient } from '@google-cloud/compute';
import { Storage } from '@google-cloud/storage';
import { CloudFunctionsServiceClient } from '@google-cloud/functions';
import { ServicesClient } from '@google-cloud/run';
import { BigQuery } from '@google-cloud/bigquery';
import { ProjectsClient } from '@google-cloud/resource-manager';
import { CloudBillingClient } from '@google-cloud/billing';
import { BudgetServiceClient } from '@google-cloud/billing-budgets';
import { ClusterManagerClient } from '@google-cloud/container';
import { Logging, Entry, Log } from '@google-cloud/logging';
import { SqlInstancesServiceClient } from '@google-cloud/sql';

const codePrompt = `Your job is to answer questions about GCP environment by writing Javascript/TypeScript code using Google Cloud Client Libraries. The code must adhere to a few rules:
- Must use promises and async/await
- Think step-by-step before writing the code, approach it logically
- Must be written in TypeScript using official Google Cloud client libraries
- Avoid hardcoded values like project IDs
- Code written should be as parallel as possible enabling the fastest and most optimal execution
- Code should handle errors gracefully, especially when doing multiple API calls
- Each error should be handled and logged with a reason, script should continue to run despite errors
- Data returned from GCP APIs must be returned as JSON containing only the minimal amount of data needed to answer the question
- All extra data must be filtered out
- Code MUST "return" a value: string, number, boolean or JSON object
- If code does not return anything, it will be considered as FAILED
- Whenever tool/function call fails, retry it 3 times before giving up
- When listing resources, ensure pagination is handled correctly
- Do not include any comments in the code
- Try to write code that returns as few data as possible to answer without any additional processing required
Be concise, professional and to the point. Do not give generic advice, always reply with detailed & contextual data sourced from the current GCP environment.`;

// Add error handlers for uncaught exceptions and unhandled rejections
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

const server = new Server(
  {
    name: "gcp-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

let selectedProject: string | null = null;
let selectedProjectCredentials: any = null;
let selectedRegion: string = "us-central1";

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "run-gcp-code",
        description: "Run GCP code",
        inputSchema: {
          type: "object",
          properties: {
            reasoning: {
              type: "string",
              description: "The reasoning behind the code",
            },
            code: {
              type: "string",
              description: codePrompt,
            },
            projectId: {
              type: "string",
              description: "GCP project ID to use",
            },
            region: {
              type: "string",
              description: "Region to use (if not provided, us-central1 is used)",
            },
          },
          required: ["reasoning", "code"],
        },
      },
      {
        name: "list-projects",
        description: "List all GCP projects accessible with current credentials",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "select-project",
        description: "Selects GCP project to use for subsequent interactions",
        inputSchema: {
          type: "object",
          properties: {
            projectId: {
              type: "string",
              description: "ID of the GCP project to select",
            },
            region: {
              type: "string",
              description: "Region to use (if not provided, us-central1 is used)",
            },
          },
          required: ["projectId"],
        },
      },
      {
        name: "get-billing-info",
        description: "Get billing information for the current project",
        inputSchema: {
          type: "object",
          properties: {
            projectId: {
              type: "string",
              description: "Project ID to get billing info for (defaults to selected project)",
            },
          },
          required: [],
        },
      },
      {
        name: "get-cost-forecast",
        description: "Get cost forecast for the current project",
        inputSchema: {
          type: "object",
          properties: {
            projectId: {
              type: "string",
              description: "Project ID to get forecast for (defaults to selected project)",
            },
            months: {
              type: "number",
              description: "Number of months to forecast (default: 3)",
            },
          },
          required: [],
        },
      },
      {
        name: "get-billing-budget",
        description: "Get billing budgets for the current project",
        inputSchema: {
          type: "object",
          properties: {
            projectId: {
              type: "string",
              description: "Project ID to get budgets for (defaults to selected project)",
            },
          },
          required: [],
        },
      },
      {
        name: "list-gke-clusters",
        description: "List all GKE clusters in the current project",
        inputSchema: {
          type: "object",
          properties: {
            location: {
              type: "string",
              description: "Location (region or zone) to list clusters from (defaults to all locations)",
            }
          },
          required: [],
        },
      },
      {
        name: "list-sql-instances",
        description: "List all Cloud SQL instances in the current project",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "get-logs",
        description: "Get Cloud Logging entries for the current project",
        inputSchema: {
          type: "object",
          properties: {
            filter: {
              type: "string",
              description: "Filter for the log entries (see Cloud Logging query syntax)",
            },
            pageSize: {
              type: "number",
              description: "Maximum number of entries to return (default: 10)",
            }
          },
          required: [],
        },
      },
      {
        name: "deploy-to-cloudrun",
        description: "Deploy a container to Cloud Run",
        inputSchema: {
          type: "object",
          properties: {
            serviceName: {
              type: "string",
              description: "Name of the Cloud Run service",
            },
            image: {
              type: "string",
              description: "Container image URL (e.g., gcr.io/project/image:tag)",
            },
            region: {
              type: "string",
              description: "Region to deploy to (defaults to selected region)",
            },
            port: {
              type: "number",
              description: "Container port (default: 8080)",
            },
            environmentVariables: {
              type: "object",
              description: "Environment variables as key-value pairs",
            },
            cpu: {
              type: "string",
              description: "CPU allocation (e.g., '1', '2', '4')",
            },
            memory: {
              type: "string",
              description: "Memory allocation (e.g., '512Mi', '1Gi', '2Gi')",
            },
            maxInstances: {
              type: "number",
              description: "Maximum number of instances (default: 100)",
            },
            minInstances: {
              type: "number",
              description: "Minimum number of instances (default: 0)",
            },
            allowUnauthenticated: {
              type: "boolean",
              description: "Allow unauthenticated requests (default: false)",
            }
          },
          required: ["serviceName", "image"],
        },
      }
    ],
  };
});

const RunGCPCodeSchema = z.object({
  reasoning: z.string(),
  code: z.string(),
  projectId: z.string().optional(),
  region: z.string().optional(),
});

const SelectProjectSchema = z.object({
  projectId: z.string(),
  region: z.string().optional(),
});

const GetBillingInfoSchema = z.object({
  projectId: z.string().optional(),
});

const GetCostForecastSchema = z.object({
  projectId: z.string().optional(),
  months: z.number().optional(),
});

const GetBillingBudgetSchema = z.object({
  projectId: z.string().optional(),
});

const ListGKEClustersSchema = z.object({
  location: z.string().optional(),
});

const GetLogsSchema = z.object({
  filter: z.string().optional(),
  pageSize: z.number().optional(),
});

const DeployToCloudRunSchema = z.object({
  serviceName: z.string(),
  image: z.string(),
  region: z.string().optional(),
  port: z.number().optional(),
  environmentVariables: z.record(z.string()).optional(),
  cpu: z.string().optional(),
  memory: z.string().optional(),
  maxInstances: z.number().optional(),
  minInstances: z.number().optional(),
  allowUnauthenticated: z.boolean().optional(),
});

interface GKECluster {
  name: string | null;
  location: string | null;
  status: string | null;
  currentNodeCount: number | null;
  currentMasterVersion: string | null;
}

interface SQLInstance {
  name: string | null;
  databaseVersion: string | null;
  state: string | null;
  region: string | null;
}

// Add retry utility function
const retry = async <T>(fn: () => Promise<T>, retries = 3): Promise<T> => {
  try {
    return await fn();
  } catch (error) {
    if (retries > 0) {
      console.error(`Operation failed, retrying... (${retries} attempts left)`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      return retry(fn, retries - 1);
    }
    throw error;
  }
};

// Initialize auth client with retry
const initializeAuth = async () => {
  try {
    const auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform']
    });
    return await retry(async () => await auth.getClient());
  } catch (error) {
    console.error('Failed to initialize authentication:', error);
    throw error;
  }
};

// Update project selection with better error handling
const selectProject = async (projectId: string, region?: string) => {
  try {
    selectedProject = projectId;
    selectedRegion = region || "us-central1";
    selectedProjectCredentials = await initializeAuth();
    return true;
  } catch (error) {
    console.error('Failed to select project:', error);
    selectedProject = null;
    selectedProjectCredentials = null;
    throw error;
  }
};

// Add documentation for available clients and example usage
const gcpClientDocs = `
Available clients and their usage:

1. compute: InstancesClient
   Example: const [instances] = await compute.list({project: selectedProject});

2. storage: Storage
   Example: const [buckets] = await storage.getBuckets();

3. functions: CloudFunctionsServiceClient
   Example: const [functions] = await functions.listFunctions({parent: \`projects/\${selectedProject}/locations/-\`});

4. run: ServicesClient
   Example: const [services] = await run.listServices({parent: \`projects/\${selectedProject}/locations/-\`});

5. bigquery: BigQuery
   Example: const [datasets] = await bigquery.getDatasets();

6. resourceManager: ProjectsClient
   Example: const [project] = await resourceManager.getProject({name: \`projects/\${selectedProject}\`});

7. container: ClusterManagerClient
   Example: const [clusters] = await container.listClusters({parent: \`projects/\${selectedProject}/locations/-\`});

8. logging: Logging
   Example: const [entries] = await logging.getEntries({pageSize: 10});

9. sql: SqlInstancesServiceClient
   Example: const [instances] = await sql.list({project: selectedProject});
`;

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
  const { name, arguments: args } = request.params;

  try {
    const auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform']
    });

    if (name === "run-gcp-code") {
      const { reasoning, code, projectId, region } = RunGCPCodeSchema.parse(args);
      
      if (!selectedProject && !projectId) {
        const projects = await listAvailableProjects();
        return createTextResponse(
          `Please select a project first using the 'select-project' tool! Available projects: ${projects.join(", ")}`
        );
      }

      if (projectId) {
        selectedProjectCredentials = await auth.getClient();
        selectedProject = projectId;
        selectedRegion = region || "us-central1";
      }

      // Initialize context with better error handling and type safety
      const context = {
        selectedProject,
        selectedRegion,
        compute: new InstancesClient({ projectId: selectedProject || undefined }),
        storage: new Storage({ projectId: selectedProject || undefined }),
        functions: new CloudFunctionsServiceClient({ projectId: selectedProject || undefined }),
        run: new ServicesClient({ projectId: selectedProject || undefined }),
        bigquery: new BigQuery({ projectId: selectedProject || undefined }),
        resourceManager: new ProjectsClient({ projectId: selectedProject || undefined }),
        container: new ClusterManagerClient({ projectId: selectedProject || undefined }),
        logging: new Logging({ projectId: selectedProject || undefined }),
        sql: new SqlInstancesServiceClient({ projectId: selectedProject || undefined }),
        // Add helper functions
        retry: async <T>(fn: () => Promise<T>, retries = 3): Promise<T> => {
          try {
            return await fn();
          } catch (error) {
            if (retries > 0) {
              console.error(`Operation failed, retrying... (${retries} attempts left)`);
              await new Promise(resolve => setTimeout(resolve, 1000));
              return context.retry(fn, retries - 1);
            }
            throw error;
          }
        },
        // Add documentation
        help: () => gcpClientDocs
      };

      try {
        const wrappedCode = wrapUserCode(code);
        const wrappedIIFECode = `(async function() { return (async () => { ${wrappedCode} })(); })()`;
        const result = await runInContext(wrappedIIFECode, createContext(context));

        return createTextResponse(JSON.stringify(result, null, 2));
      } catch (error: any) {
        console.error('Error executing GCP code:', error);
        return createTextResponse(`Error executing GCP code: ${error.message}\n\nAvailable clients and their usage:\n${gcpClientDocs}`);
      }
    } else if (name === "list-projects") {
      const projects = await listAvailableProjects();
      return createTextResponse(JSON.stringify({ projects }));
    } else if (name === "select-project") {
      const { projectId, region } = SelectProjectSchema.parse(args);
      selectedProjectCredentials = await auth.getClient();
      selectedProject = projectId;
      selectedRegion = region || "us-central1";
      return createTextResponse("Project selected successfully!");
    } else if (name === "get-billing-info") {
      const { projectId } = GetBillingInfoSchema.parse(args);
      const targetProject = projectId || selectedProject;
      
      if (!targetProject) {
        return createTextResponse("No project selected. Please select a project first.");
      }

      try {
        const billingClient = new CloudBillingClient();
        const [billingInfo] = await billingClient.getProjectBillingInfo({
          name: `projects/${targetProject}`
        });

        if (!billingInfo.billingEnabled) {
          return createTextResponse("Billing is not enabled for this project.");
        }

        const billingAccount = billingInfo.billingAccountName;
        if (!billingAccount) {
          return createTextResponse("No billing account associated with this project.");
        }

         // Get billing account details
        const [account] = await billingClient.getBillingAccount({
          name: billingAccount
        });

        return createTextResponse(JSON.stringify({
          projectId: targetProject,
          billingEnabled: billingInfo.billingEnabled,
          billingAccountName: billingAccount,
          displayName: account.displayName,
          open: account.open
        }, null, 2));
      } catch (error: any) {
        console.error('Error getting billing info:', error);
        if (error.code === 7) {
          return createTextResponse("Error: Cloud Billing API is not enabled. Please enable it in the Google Cloud Console.");
        }
        return createTextResponse(`Error getting billing info: ${error.message}`);
      }
    } else if (name === "get-cost-forecast") {
      const { projectId, months = 3 } = GetCostForecastSchema.parse(args);
      const targetProject = projectId || selectedProject;
      
      if (!targetProject) {
        return createTextResponse("No project selected. Please select a project first.");
      }

      try {
        const billingClient = new CloudBillingClient();
        const [billingInfo] = await billingClient.getProjectBillingInfo({
          name: `projects/${targetProject}`
        });

        if (!billingInfo.billingEnabled) {
          return createTextResponse("Billing is not enabled for this project.");
        }

        const billingAccount = billingInfo.billingAccountName;
        if (!billingAccount) {
          return createTextResponse("No billing account associated with this project.");
        }

        // Get cost forecast using Cloud Billing API
        const [costInfo] = await billingClient.getProjectBillingInfo({
          name: `projects/${targetProject}`
        });

        return createTextResponse(JSON.stringify({
          projectId: targetProject,
          billingAccount: billingAccount,
          billingEnabled: costInfo.billingEnabled,
          currency: 'USD'
        }, null, 2));
      } catch (error: any) {
        console.error('Error getting cost forecast:', error);
        if (error.code === 7) {
          return createTextResponse("Error: Cloud Billing API is not enabled. Please enable it in the Google Cloud Console.");
        }
        return createTextResponse(`Error getting cost forecast: ${error.message}`);
      }
    } else if (name === "get-billing-budget") {
      const { projectId } = GetBillingBudgetSchema.parse(args);
      const targetProject = projectId || selectedProject;
      
      if (!targetProject) {
        return createTextResponse("No project selected. Please select a project first.");
      }

      try {
        const billingClient = new CloudBillingClient();
        const [billingInfo] = await billingClient.getProjectBillingInfo({
          name: `projects/${targetProject}`
        });

        if (!billingInfo.billingEnabled) {
          return createTextResponse("Billing is not enabled for this project.");
        }

        const billingAccount = billingInfo.billingAccountName;
        if (!billingAccount) {
          return createTextResponse("No billing account associated with this project.");
        }

        // Use the BudgetServiceClient to list budgets
        const budgetClient = new BudgetServiceClient();
        const [budgets] = await budgetClient.listBudgets({
          parent: billingAccount
        });

        interface Budget {
          name: string | null;
          displayName: string | null;
          amount: {
            units: string | null;
            currencyCode: string | null;
          };
          thresholdRules: Array<{
            thresholdPercent: number | null;
            spendBasis: string | null;
          }>;
        }

        const formattedBudgets = budgets.map((budget: any) => ({
          name: budget.name ?? null,
          displayName: budget.displayName ?? null,
          amount: budget.amount ? {
            units: budget.amount.units ?? null,
            currencyCode: budget.amount.currencyCode ?? null
          } : null,
          thresholdRules: budget.thresholdRules?.map((rule: any) => ({
            thresholdPercent: rule.thresholdPercent ?? null,
            spendBasis: rule.spendBasis ?? null
          })) ?? []
        }));

        return createTextResponse(JSON.stringify({
          projectId: targetProject,
          billingAccount: billingAccount,
          budgets: formattedBudgets
        }, null, 2));
      } catch (error: any) {
        console.error('Error getting billing budgets:', error);
        if (error.code === 7) {
          return createTextResponse("Error: Cloud Billing API or Cloud Billing Budgets API is not enabled. Please enable it in the Google Cloud Console.");
        }
        return createTextResponse(`Error getting billing budgets: ${error.message}`);
      }
    } else if (name === "list-gke-clusters") {
      const { location } = ListGKEClustersSchema.parse(args);
      
      if (!selectedProject) {
        return createTextResponse("No project selected. Please select a project first.");
      }

      try {
        const containerClient = new ClusterManagerClient();
        const parent = location 
          ? `projects/${selectedProject}/locations/${location}`
          : `projects/${selectedProject}/locations/-`;
        
        const [clusters] = await containerClient.listClusters({ parent });
        
        return createTextResponse(JSON.stringify({
          clusters: clusters.clusters?.map((cluster: any) => ({
            name: cluster.name || null,
            location: cluster.location || null,
            status: cluster.status || null,
            nodeCount: cluster.currentNodeCount || null,
            k8sVersion: cluster.currentMasterVersion || null
          })) || []
        }, null, 2));
      } catch (error: any) {
        console.error('Error listing GKE clusters:', error);
        return createTextResponse(`Error listing GKE clusters: ${error.message}`);
      }
    } else if (name === "list-sql-instances") {
      if (!selectedProject) {
        return createTextResponse("No project selected. Please select a project first.");
      }

      try {
        const sqlClient = new SqlInstancesServiceClient({
           fallback: 'rest'  // Use HTTP/1.1 fallback mode instead of gRPC
        });
        
        const request = {
          project: selectedProject
        };

        const [response] = await sqlClient.list(request);

        return createTextResponse(JSON.stringify({
          instances: (response?.items || []).map(instance => ({
            name: instance.name || null,
            databaseVersion: instance.databaseVersion || null,
            state: instance.state || null,
            region: instance.region || null
          }))
        }, null, 2));
      } catch (error: any) {
        console.error('Error listing SQL instances:', error);
        return createTextResponse(`Error listing SQL instances: ${error.message}`);
      }
    } else if (name === "get-logs") {
      const { filter, pageSize = 10 } = GetLogsSchema.parse(args);
      
      if (!selectedProject) {
        return createTextResponse("No project selected. Please select a project first.");
      }

      try {
        const logging = new Logging({
          projectId: selectedProject
        });
        const [entries] = await logging.getEntries({
          pageSize,
          filter: filter || undefined,
          orderBy: 'timestamp desc'
        });
        
        return createTextResponse(JSON.stringify({
          entries: entries.map((entry: Entry) => ({
            timestamp: entry.metadata.timestamp,
            severity: entry.metadata.severity,
            resource: entry.metadata.resource,
            textPayload: entry.data,
            jsonPayload: typeof entry.data === 'object' ? entry.data : null
          }))
        }, null, 2));
      } catch (error: any) {
        console.error('Error getting logs:', error);
        return createTextResponse(`Error getting logs: ${error.message}`);
      }
    } else if (name === "deploy-to-cloudrun") {
      const {
        serviceName,
        image,
        region,
        port = 8080,
        environmentVariables,
        cpu = '1000m',
        memory = '512Mi',
        maxInstances = 100,
        minInstances = 0,
        allowUnauthenticated = false
      } = DeployToCloudRunSchema.parse(args);
      
      if (!selectedProject) {
        return createTextResponse("No project selected. Please select a project first.");
      }

      const targetRegion = region || selectedRegion;
      const normalizedServiceName = serviceName.toLowerCase().replace(/[^a-z0-9\-]/g, '-').replace(/^[^a-z]/, 'a').replace(/-+$/, '').substring(0, 49);

      try {
        const runClient = new ServicesClient();
        const parent = `projects/${selectedProject}/locations/${targetRegion}`;

        const envVars = environmentVariables ? 
          Object.entries(environmentVariables).map(([key, value]) => ({ name: key, value })) : [];

        const service = {
          template: {
            containers: [{
              image,
              ports: [{
                containerPort: port
              }],
              env: envVars,
              resources: {
                limits: {
                  cpu,
                  memory
                }
              }
            }],
            scaling: {
              maxInstanceCount: maxInstances,
              minInstanceCount: minInstances
            }
          },
          traffic: [{
            percent: 100,
            type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST'
          }]
        };

        let result;
        let isUpdate = false;

        try {
          const servicePath = `${parent}/services/${normalizedServiceName}`;
          const [existingService] = await runClient.getService({ name: servicePath });
          if (existingService && existingService.metadata) {
            isUpdate = true;
          }
        } catch (error: any) {
          if (error.code !== 5) {
            console.error('Error checking existing service:', error.message);
          }
        }

        if (isUpdate) {
          const servicePath = `${parent}/services/${normalizedServiceName}`;
          const [operation] = await retry(async () => await runClient.updateService({
            service: {
              name: servicePath,
              ...service
            },
            allowMissing: false
          }));
          [result] = await operation.promise();
        } else {
          const [operation] = await retry(async () => await runClient.createService({
            parent,
            serviceId: normalizedServiceName,
            service: service
          }));
          [result] = await operation.promise();
        }

        if (allowUnauthenticated && result) {
          try {
            const servicePath = `${parent}/services/${normalizedServiceName}`;
            await retry(async () => {
              const policyRequest = {
                resource: servicePath,
                policy: {
                  bindings: [{
                    role: 'roles/run.invoker',
                    members: ['allUsers']
                  }]
                }
              };
              return await runClient.setIamPolicy(policyRequest);
            });
          } catch (iamError: any) {
            console.error('Warning: Could not set public access policy:', iamError.message);
          }
        }

        const serviceUrl = result?.uri || result?.status?.url || `https://${normalizedServiceName}-${selectedProject}.a.run.app`;
        
        return createTextResponse(JSON.stringify({
          serviceName: normalizedServiceName,
          originalServiceName: serviceName,
          url: serviceUrl,
          region: targetRegion,
          status: result?.conditions?.[0]?.state || result?.status?.conditions?.[0]?.status || 'Deploying',
          ready: result?.conditions?.[0]?.state === 4 || result?.status?.conditions?.[0]?.status === 'True',
          image,
          lastModified: result?.createTime || result?.metadata?.creationTimestamp || new Date().toISOString(),
          revision: result?.latestRevision || result?.status?.latestRevision,
          operation: isUpdate ? 'update' : 'create'
        }, null, 2));
      } catch (error: any) {
        console.error('Error deploying to Cloud Run:', error);
        if (error.code === 7) {
          return createTextResponse("Error: Cloud Run API is not enabled. Please enable it in the Google Cloud Console.");
        }
        if (error.code === 3) {
          return createTextResponse(`Error: Invalid request - ${error.message}. Check service name format and template structure.`);
        }
        return createTextResponse(`Error deploying to Cloud Run: ${error.message}`);
      }
    } else {
      throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    console.error('Error:', error);
    return createTextResponse(`Error: ${error.message}`);
  }
});

function wrapUserCode(userCode: string) {
  const project = new Project({
    useInMemoryFileSystem: true,
  });
  const sourceFile = project.createSourceFile("userCode.ts", userCode);
  const lastStatement = sourceFile.getStatements().pop();

  if (
    lastStatement &&
    lastStatement.getKind() === SyntaxKind.ExpressionStatement
  ) {
    const returnStatement = lastStatement.asKind(SyntaxKind.ExpressionStatement);
    if (returnStatement) {
      const expression = returnStatement.getExpression();
      sourceFile.addStatements(`return ${expression.getText()};`);
      returnStatement.remove();
    }
  }

  return sourceFile.getFullText();
}

async function listAvailableProjects(): Promise<string[]> {
  const projectsClient = new ProjectsClient();
  
  try {
    const [projects] = await projectsClient.searchProjects();
    return projects.map((p: any) => JSON.stringify(p));
  } catch (error) {
    console.error('Error listing projects:', error);
    return [];
  }
}

// Initialize transport with error handling
const transport = new StdioServerTransport();

// Wrap server connection in async function for better error handling
async function startServer() {
  try {
    await server.connect(transport);
    console.error("GCP MCP Server running on stdio");
  } catch (error) {
    console.error("Failed to start GCP MCP Server:", error);
    process.exit(1);
  }
}

// Start the server
startServer();

const createTextResponse = (text: string) => ({
  content: [{ type: "text", text }],
});