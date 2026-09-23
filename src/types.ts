import type { AssistantMessage, Context, Tool } from "@earendil-works/pi-ai";
import type { SessionResolution } from "./session-registry.ts";

export type ClaudeSubscriptionType = "pro" | "max" | "team" | "enterprise";

export interface ClaudeInstallation {
  executable: string;
  version: string;
  subscriptionType: ClaudeSubscriptionType;
}

export interface ClaudeAuthStatus {
  loggedIn?: boolean;
  authMethod?: string;
  apiProvider?: string;
  subscriptionType?: string;
}

export interface PreparedRequest {
  directory: string;
  imageStoreDirectory?: string;
  transcriptBlocks: string[];
  attachmentPaths: string[];
  systemPromptPath: string;
  catalogPath?: string;
  violationPath?: string;
  readyPath?: string;
  bunConfigPath?: string;
  toolNames: Map<string, string>;
  transcriptBytes: number;
  catalogBytes: number;
  /** Image content blocks, which is what the per-request image limit counts. */
  imageCount: number;
  /** Bytes actually written, so identical images are counted once. */
  imageBytes: number;
}

export interface RequestMetrics {
  /** 5 changed `imageCount` from written attachments to image content blocks. */
  schemaVersion: 5;
  timestamp: string;
  platform: NodeJS.Platform;
  architecture: string;
  nodeVersion: string;
  claudeVersion: string;
  requestedModel: string;
  resolvedModel?: string;
  effort: string;
  messageCount: number;
  toolCount: number;
  /** Where this request's working directory came from; absent when no session was resolved. */
  sessionResolution?: SessionResolution;
  /** Image content blocks, matching what an `image_count` rejection counted. */
  imageCount: number;
  transcriptBytes: number;
  catalogBytes: number;
  imageBytes: number;
  estimatedInputTokens: number;
  servedContextWindow?: number;
  servedMaxOutputTokens?: number;
  cacheRead: number;
  cacheWrite: number;
  cacheHitPercent?: number;
  inputTokens: number;
  outputTokens: number;
  durationMs?: number;
  lastPhase: string;
  cleanupComplete: boolean;
  stopReason?: string;
  errorCategory?: string;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | null;
  terminationExpected: boolean;
}

export interface SearchMetrics {
  schemaVersion: 1;
  timestamp: string;
  platform: NodeJS.Platform;
  architecture: string;
  nodeVersion: string;
  claudeVersion: string;
  requestBytes: number;
  capturedBytes: number;
  resultBytes: number;
  durationMs: number;
  lastPhase: string;
  initialized: boolean;
  cleanupComplete: boolean;
  errorCategory?: string;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | null;
}

export interface LogicalProviderPayload {
  systemPrompt?: string;
  messages: Context["messages"];
  tools?: Tool[];
}

/** The assistant message a provider request builds up and publishes. */
export type MutableOutput = AssistantMessage;
