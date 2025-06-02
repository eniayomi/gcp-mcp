# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Model Context Protocol (MCP) server for Google Cloud Platform that enables AI assistants to interact with GCP resources using natural language. The server exposes various GCP services through TypeScript code execution and predefined tools.

## Development Commands

- `npm run dev` - Start development server with file watching using tsx
- `npm run build` - Compile TypeScript to JavaScript 
- `npm run start` - Run the compiled server
- `npm test` - Run the test script (executes bin.js)

## Architecture

### Core Components

**Main Server (`index.ts:53-63`)**
- MCP server implementation using `@modelcontextprotocol/sdk`
- Handles tool registration and request routing
- Maintains global state for selected project and credentials

**Code Execution Engine (`index.ts:24-40`)**
- Sandboxed TypeScript/JavaScript execution using Node.js `vm` module
- Automatic wrapping of user code to ensure return values
- Context injection with GCP client libraries

**Authentication (`index.ts:279-290`)**
- Uses Google Auth Library with application default credentials
- Automatic retry logic for auth failures
- Project-scoped credential management

### Tool Architecture

The server exposes 9 main tools divided into categories:

1. **Code Execution**: `run-gcp-code` - Executes arbitrary TypeScript with GCP context
2. **Project Management**: `list-projects`, `select-project`  
3. **Billing**: `get-billing-info`, `get-cost-forecast`, `get-billing-budget`
4. **Services**: `list-gke-clusters`, `list-sql-instances`, `get-logs`

Each tool has strict input validation using Zod schemas and standardized error handling.

### GCP Client Integration

Pre-initialized clients available in code execution context:
- `compute`: Compute Engine instances
- `storage`: Cloud Storage buckets  
- `functions`: Cloud Functions
- `run`: Cloud Run services
- `bigquery`: BigQuery datasets/tables
- `container`: GKE clusters
- `logging`: Cloud Logging entries
- `sql`: Cloud SQL instances

## Key Patterns

**Error Handling (`index.ts:265-277`)**
- Global retry mechanism with exponential backoff
- Graceful degradation for API failures
- Detailed error logging without exposing sensitive data

**State Management (`index.ts:65-67`)**
- Global variables for selected project/region/credentials
- Stateful session management across tool calls
- Project validation before resource access

**Code Wrapping (`index.ts:658-678`)**
- Automatic transformation of expression statements to return statements
- TypeScript AST manipulation using ts-morph
- Ensures all user code produces output

## Important Notes

- All GCP API calls should handle pagination appropriately
- The server expects application default credentials to be configured
- Code execution is sandboxed but not fully isolated
- Selected project state persists across tool invocations
- All client libraries use the currently selected project by default