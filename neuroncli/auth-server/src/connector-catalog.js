// Hosted connector catalog (docs/PLATFORM_CONTRACT.md section 14.4). Each entry is a SaaS vendor
// whose official remote MCP server https://zero-x.live/mcp/<id> proxies to (src/mcp-proxy.js),
// with the OAuth endpoints the gateway links accounts through (src/routes/connectors.js) and the
// tool tiers the proxy enforces. The ids are the ones plans grant in
// zerox_plan_policy.connector_policy.hosted (migration 20261104000000) and must equal the CLI
// catalog's ids.
//
// Provider config comes from env vars named per connector, CONNECTOR_<ID>_<FIELD> (ID upper-case,
// other characters as "_"): CLIENT_ID, CLIENT_SECRET (secret), SCOPES (space or comma separated),
// and overrides MCP_URL, AUTHORIZE_URL, TOKEN_URL, REVOKE_URL (https only). A connector serves
// only when its client id and every URL are known; none are set as of 2026-11-04, so every
// connector reports `configured: false` until the owner registers an OAuth app per vendor.
//
// What was checked (web, 2026-11-04), and what still needs the owner:
// - github: remote server https://api.githubcopilot.com/mcp/ (Streamable HTTP), source
//   github/github-mcp-server (MIT, maintained by GitHub; releases v1.4/v1.5 on pkg.go.dev). It
//   accepts a bearer token; hosts that use OAuth register their own GitHub OAuth or GitHub App.
//   OAuth endpoints are GitHub's standard ones. Not verified: that an OAuth app's user token (as
//   opposed to a PAT) is accepted with every toolset; check on staging.
// - linear: https://mcp.linear.app/mcp (Streamable HTTP; /sse deprecated), vendor-operated. Linear
//   documents passing OAuth tokens and API keys as `Authorization: Bearer` (linear.app/docs/mcp).
//   OAuth endpoints are Linear's API OAuth app endpoints.
// - slack: https://mcp.slack.com/mcp (Streamable HTTP, no SSE, no dynamic client registration),
//   vendor-operated. User tokens from https://slack.com/oauth/v2_user/authorize and
//   https://slack.com/api/oauth.v2.user.access with the app's client id and secret
//   (docs.slack.dev/ai/mcp-server). Only Marketplace-published or internal Slack apps may use it,
//   and scopes vary per tool, so CONNECTOR_SLACK_SCOPES has no default and must be set.
// - notion: https://mcp.notion.com/mcp (GA, vendor-operated; the open-source makenotion server is
//   soft-deprecated in its favour). OAuth 2.0 with PKCE through the authorization server its
//   protected-resource metadata names, so the AUTHORIZE_URL and TOKEN_URL (and the client id,
//   registered for zero-x.live) come from that discovery and are set by the owner.
// - atlassian: Rovo MCP server, vendor-operated (atlassian/atlassian-mcp-server holds its docs;
//   Apache-2.0, GA). OAuth 2.1 is the primary method. Its README (2026-11-04) recommends
//   https://mcp.atlassian.com/v2/mcp and retires the legacy SSE endpoint after 2026-06-30, so that
//   is the default MCP_URL; AUTHORIZE_URL, TOKEN_URL and SCOPES have no default and are set by the
//   owner from the authorization server the v2 endpoint advertises.
//
// Tool tiers (read, write, external, destructive, blocked): an entry's explicit `tools` map wins,
// then its `patterns`, then the shared name patterns below; a tool matching none is `write`.
// Patterns see the normalized name (normalizeToolName): the vendor prefix ("notion-", "slack_")
// removed and camelCase split into snake_case words, so `deleteConfluencePage` is
// `delete_confluence_page`. `destructive` calls need `x-neuron-confirmed: 1`; `blocked` tools are
// removed from tools/list and refused. The vendor's own annotations can only make a tool's tier
// stricter (effectiveTier): `destructiveHint: true` makes it destructive and `readOnlyHint: false`
// takes it out of `read`; the proxy remembers those per user and connector for tools/call.
//
// Explicit tool maps (checked on the web 2026-11-04):
// - atlassian: every tool on Atlassian's published list (support.atlassian.com, Atlassian Rovo MCP
//   server, "Supported tools"), by its permission group: read_*/search_* are read, write_* write,
//   delete_jira and the mutating manage_jira tools destructive, plus the overrides noted below.
//   Repository atlassian/atlassian-mcp-server: Apache-2.0, GA, maintained by Atlassian.
// - notion: the tool names of Notion's hosted server (notion-search, notion-fetch, ...). Notion's
//   own docs page lists tool categories, not names; the names come from third-party listings that
//   agree with each other, so check them against tools/list on staging. Notion publishes no
//   delete tool; the shared rules catch one if it appears.
// - linear: Linear's docs list no tool names (only "finding, creating and updating" issues,
//   projects and comments); its names are snake_case verb-first (list_issues, save_issue), which the
//   shared rules tier correctly, so it has no explicit map.
// - github: the destructive tools of github/github-mcp-server; the rest by the shared rules.

export const HOSTED_CATALOG_VERSION = '2026-11-04';
export const TIERS = Object.freeze(['read', 'write', 'external', 'destructive', 'blocked']);
const TIER_RANK = Object.freeze({ read: 0, write: 1, external: 2, destructive: 3, blocked: 4 });

const READ_TOOL = /^(get|list|search|read|fetch|find|query|lookup|view|describe|retrieve|whoami|me|download|export|diff|discover)(?:_|$)/;
const DESTRUCTIVE_TOOL = /(?:^|_)(delete|remove|archive|close|merge|revoke|drop|destroy|cancel|transfer|reset|purge|dismiss|restore)(?:_|$)/;

const toolMap = groups => {
  const tools = {};
  for (const [tier, names] of Object.entries(groups)) for (const name of names.split(/\s+/).filter(Boolean)) tools[name] = tier;
  return tools;
};
const entry = value => Object.freeze({ ...value, scopes: value.scopes ? Object.freeze(value.scopes) : null,
  tools: Object.freeze(value.tools || {}), patterns: Object.freeze(value.patterns || []),
  prefixes: Object.freeze(value.prefixes || []) });

// Atlassian Rovo MCP server, published tool list (permission groups in brackets).
const ATLASSIAN_TOOLS = toolMap({
  read: `atlassianUserInfo getAccessibleAtlassianResources discover executeRead getContentFormatGuide
    getJiraIssue listJiraProjects listJiraProjectIssueTypesMetadata getJiraIssueTypeMetaWithFields listJiraIssueTransitions
    listJiraIssueLinkTypes listJiraIssueRemoteIssueLinks listJiraIssueWorklogs lookupJiraAccountId listJiraIssueAssignableUsers
    listJiraIssueComments listJiraIssueChangelogs getJiraCurrentUser getJiraUser listJiraStatuses listJiraProjectComponents
    getJiraProjectVersions getJiraProjectVersionRelatedWork listJiraBoards getJiraBoardConfig getJiraBoardIssueData
    getJiraBoardSprintData listJiraBoardSprints listJiraFilters listJiraDashboards getJiraEntityProperty
    downloadJiraIssueAttachment searchJiraIssuesUsingJql getJiraWorkflows getJiraWorkflowEditorLink getJiraScreen
    getConfluenceContent listConfluenceContent listConfluenceSpaces getConfluenceSpace getConfluenceSpaceInstructions
    getConfluencePersonalSpace listConfluenceComments getConfluenceComment listConfluenceContentVersions
    getConfluenceContentVersion diffConfluenceContentVersions listConfluenceAttachments getConfluenceAttachment
    downloadConfluenceAttachment exportConfluenceContent getConfluenceContentPermissions getConfluenceContentRestrictionState
    getConfluencePublicLinkStatus getConfluenceReactions getConfluenceTask listConfluenceTasks listConfluenceTemplates
    getConfluenceTemplate resolveConfluenceContentMacros getConfluenceMauiApp searchConfluence
    getJsmOpsAlerts getJsmOpsScheduleInfo getJsmOpsTeamInfo getJsmRequestResolverPlans searchJsmRequests getJsmRequest
    getJsmRequestActionMetadata getJsmRequestCreationOptions getJsmRequestTypeFields getJsmAgentAvailability
    listBitbucketWorkspaces getBitbucketWorkspace listBitbucketRepositories getBitbucketRepository
    getBitbucketRepoDefaultReviewers getBitbucketRepoFileContent getBitbucketRepoBranch getBitbucketRepoCommit
    listBitbucketRepoCommitReports getBitbucketRepoCommitReport getBitbucketRepoCommitReportAnnotations
    listBitbucketRepoPullRequests getBitbucketRepoPullRequest getBitbucketRepoPullRequestDiff
    listBitbucketRepoPullRequestComments listBitbucketRepoPullRequestTasks listBitbucketRepoPipelines getBitbucketRepoPipeline
    listBitbucketRepoPipelineSteps getBitbucketRepoPipelineStep getBitbucketRepoPipelineStepLog listBitbucketRepoDeployments
    getBitbucketRepoDeployment listBitbucketRepoEnvironments getBitbucketRepoEnvironment
    getTeamworkGraphContext getTeamworkGraphObject getPeopleInfo getWorkPortfolio getWorkActivity getPullRequests
    getCollaborators search searchCode getCodeFile listCodeDirectory scanCodeRepo getCodeSymbol diffCodeSymbols
    getAssetsObject getAssetsObjectsById getAssetsObjectSchema getAssetsObjectType getAssetsServiceObjectsById
    listAssetsObjectSchemas listAssetsObjectTypeAttributes queryAssetsObjects queryAssetsObjectSchemaAttributes
    queryAssetsObjectsUsingAql queryAssetsObjectTypes queryAssetsReferenceTypes searchAssetsObjects
    getLoomObjectsContent listLoomObjects getLoomVideoDownloadUrl listLoomObjectFolders
    searchGoals getGoal getGoalUpdate getGoalTypes searchProjects getProject getProjectUpdate searchTeams getTeam
    searchFocusAreas getFocusArea getFocusAreaTypes getTalentUser getTalentFields searchTalentPositions getTalentPosition
    getTalentPositionsByEntity getTalentGroupMetrics searchTalentSkillTaxonomy getCapacityPlanAllocations
    searchCapacityPlanNonProjectWork getJiraAlignTerminology describeJiraAlignItemType getJiraAlignItem listJiraAlignItems`,
  write: `executeWrite createJiraIssue editJiraIssue transitionJiraIssue addOrEditJiraIssueComment addOrEditJiraIssueWorklog
    createJiraIssueLink manageJiraProjectVersion manageJiraProjectVersionRelatedWork manageJiraSprint createJiraBoard
    watchJiraIssue uploadAttachmentToJiraIssue editJiraEntityProperty createJiraIssueRemoteIssueLink convertJiraIssueHierarchy
    createConfluenceContent updateConfluenceContent createConfluenceSpace setConfluenceSpaceInstructions copyConfluenceContent
    moveConfluenceContent unarchiveConfluenceContent convertConfluenceContentMode setConfluenceContentStatus
    createConfluenceComment updateConfluenceComment updateConfluenceCommentResolution createConfluenceAttachment
    addLabelsToConfluenceContent addConfluenceReaction disableConfluencePublicLink completeConfluenceTask reopenConfluenceTask
    starConfluenceContent unstarConfluenceContent starConfluenceSpace unstarConfluenceSpace watchConfluenceContent
    unwatchConfluenceContent watchConfluenceSpace unwatchConfluenceSpace watchConfluenceLabel unwatchConfluenceLabel
    createConfluenceInfographicForPage editConfluenceInfographicForPage createConfluenceMauiApp editConfluenceMauiApp
    updateJsmOpsAlert approveJsmRequestResolverPlans transitionJsmRequest createJsmRequest decideJsmRequestApproval
    setJsmAgentAvailability createBitbucketRepoPullRequest updateBitbucketRepoPullRequest approveBitbucketRepoPullRequest
    requestChangesOnBitbucketRepoPullRequest addBitbucketRepoPullRequestComment resolveBitbucketRepoPullRequestComment
    reopenBitbucketRepoPullRequestComment createBitbucketRepoPullRequestTask setBitbucketRepoPullRequestTaskState
    createBitbucketRepoBranch createBitbucketRepoCommit addTeamworkGraphContext createLoomObjectUpload
    updateLoomObjectMetadata createLoomObjectFolder moveLoomObjectToFolder recoverLoomVideo addLoomInteraction
    createGoal createGoalUpdate addConnectionsToGoals createProject createProjectUpdate addConnectionsToProjects createTeam
    updateTeam createFocusArea updateFocusArea createFocusAreaStatusUpdate linkToFocusArea createTalentSkill
    updateTalentWorkerSkillMappings updateTalentPositionFocusAreaMappings updateCapacityPlanAllocation
    createCapacityPlanNonProjectWork updateCapacityPlanNonProjectWork createJiraAlignItem updateJiraAlignItem`,
  // Content leaves the account's private context (public links, sharing, publishing).
  external: `enableConfluencePublicLink publishLoomObject shareLoomObject updateLoomObjectVisibility`,
  // [delete_jira], the mutating [manage_jira] tools, permission and restriction changes, version
  // restores, archiving, merges, pipeline runs (which can deploy) and the generic destructive call.
  destructive: `executeDestructive deleteJiraIssue deleteJiraComment deleteJiraIssueAttachment createJiraProject
    updateJiraProject updateJiraScreen archiveConfluenceContent restoreConfluenceContentVersion
    addConfluenceContentPermissions removeConfluenceContentPermissions replaceConfluenceContentPermissions
    setConfluenceContentRestrictionState mergeBitbucketRepoPullRequest runBitbucketRepoPipeline`,
});

const NOTION_TOOLS = toolMap({
  read: `notion-search notion-fetch notion-get-comments notion-get-teams notion-get-users notion-get-user notion-get-self
    notion-query-data-sources notion-query-database-view`,
  write: `notion-create-pages notion-update-page notion-move-pages notion-duplicate-page notion-create-database
    notion-update-database notion-update-data-source notion-create-comment`,
});

export const HOSTED_CONNECTORS = Object.freeze([
  entry({
    id: 'atlassian', name: 'Atlassian (Jira and Confluence)', publisher: 'Atlassian',
    source: 'Atlassian Rovo MCP server (vendor-operated; docs atlassian/atlassian-mcp-server, Apache-2.0)',
    mcp_url: 'https://mcp.atlassian.com/v2/mcp', authorize_url: null, token_url: null,
    scopes: null, scope_param: 'scope', scope_separator: ' ', resource: true,
    tools: ATLASSIAN_TOOLS, prefixes: ['atlassian'],
  }),
  entry({
    id: 'github', name: 'GitHub', publisher: 'GitHub', source: 'github/github-mcp-server (MIT)',
    mcp_url: 'https://api.githubcopilot.com/mcp/',
    authorize_url: 'https://github.com/login/oauth/authorize',
    token_url: 'https://github.com/login/oauth/access_token',
    scopes: ['repo', 'read:org'], scope_param: 'scope', scope_separator: ' ', resource: false,
    tools: { delete_file: 'destructive', merge_pull_request: 'destructive', push_files: 'write' }, prefixes: ['github'],
  }),
  entry({
    id: 'linear', name: 'Linear', publisher: 'Linear', source: 'Linear remote MCP server (vendor-operated)',
    mcp_url: 'https://mcp.linear.app/mcp',
    authorize_url: 'https://linear.app/oauth/authorize',
    token_url: 'https://api.linear.app/oauth/token',
    scopes: ['read', 'write'], scope_param: 'scope', scope_separator: ',', resource: false, prefixes: ['linear'],
  }),
  entry({
    id: 'notion', name: 'Notion', publisher: 'Notion', source: 'Notion hosted MCP server (vendor-operated)',
    mcp_url: 'https://mcp.notion.com/mcp', authorize_url: null, token_url: null,
    scopes: [], scope_param: 'scope', scope_separator: ' ', resource: true,
    tools: NOTION_TOOLS, prefixes: ['notion'],
  }),
  entry({
    id: 'slack', name: 'Slack', publisher: 'Slack', source: 'Slack MCP server (vendor-operated)',
    mcp_url: 'https://mcp.slack.com/mcp',
    authorize_url: 'https://slack.com/oauth/v2_user/authorize',
    token_url: 'https://slack.com/api/oauth.v2.user.access',
    scopes: null, scope_param: 'scope', scope_separator: ',', resource: false,
    // Messages leave the workspace's private context: shown as external, not destructive.
    patterns: [[/(?:^|_)(send|post|schedule|reply)(?:_|$)/, 'external']], prefixes: ['slack'],
  }),
]);

export function hostedConnector(id) {
  return HOSTED_CONNECTORS.find(connector => connector.id === id) || null;
}

// The name the shared rules and an entry's patterns see: lower-case snake_case words, without the
// vendor's prefix. `deleteConfluencePage` -> `delete_confluence_page`, `notion-search` -> `search`,
// `slack_send_message` -> `send_message`, `getJiraIssue` -> `get_jira_issue`.
export function normalizeToolName(connector, name) {
  let words = String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  for (const prefix of connector?.prefixes || []) {
    if (words.length > 1 && words[0] === prefix) { words = words.slice(1); break; }
  }
  return words.join('_');
}

// The catalog tier of a tool, by its name only.
export function toolTier(connector, name) {
  const tool = String(name || '');
  if (connector && Object.hasOwn(connector.tools, tool)) return connector.tools[tool];
  const normalized = normalizeToolName(connector, tool);
  for (const [pattern, tier] of connector?.patterns || []) if (pattern.test(normalized)) return tier;
  if (DESTRUCTIVE_TOOL.test(normalized)) return 'destructive';
  if (READ_TOOL.test(normalized)) return 'read';
  return 'write';
}

// The stricter of two tiers.
export function stricterTier(left, right) {
  if (!Object.hasOwn(TIER_RANK, right)) return left;
  if (!Object.hasOwn(TIER_RANK, left)) return right;
  return TIER_RANK[right] > TIER_RANK[left] ? right : left;
}

// The tier of a tool as the vendor's tools/list describes it: the catalog tier, made stricter (never
// looser) by the vendor's own annotations. An explicit `destructiveHint: true` makes the tool
// destructive; an explicit `readOnlyHint: false` makes a catalog `read` tool `write`. Hints the
// vendor leaves out change nothing (MCP's default destructiveHint would make every write tool
// destructive).
export function effectiveTier(connector, tool) {
  const tier = toolTier(connector, tool?.name);
  if (tier === 'blocked') return tier;
  const hints = tool && typeof tool.annotations === 'object' && tool.annotations ? tool.annotations : {};
  let effective = tier;
  if (hints.destructiveHint === true) effective = stricterTier(effective, 'destructive');
  if (hints.readOnlyHint === false) effective = stricterTier(effective, 'write');
  return effective;
}

const envName = (id, field) => `CONNECTOR_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${field}`;
const envText = (env, id, field) => {
  const value = env?.[envName(id, field)];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};
// https URLs only, without credentials; anything else is no URL.
export function httpsUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch { return null; }
}

// The connector's provider config from the catalog and its env vars. `configured` is false (with
// the missing names) until a client id and every URL are known. The client secret is returned
// for the token exchange only; callers never log or return it.
export function connectorConfig(env, connector) {
  const id = connector.id;
  const scopesText = envText(env, id, 'SCOPES');
  const scopes = scopesText !== null ? scopesText.split(/[\s,]+/).filter(Boolean).slice(0, 64) : connector.scopes;
  const config = {
    id,
    mcpUrl: httpsUrl(envText(env, id, 'MCP_URL') ?? connector.mcp_url),
    authorizeUrl: httpsUrl(envText(env, id, 'AUTHORIZE_URL') ?? connector.authorize_url),
    tokenUrl: httpsUrl(envText(env, id, 'TOKEN_URL') ?? connector.token_url),
    revokeUrl: httpsUrl(envText(env, id, 'REVOKE_URL')),
    clientId: envText(env, id, 'CLIENT_ID'),
    clientSecret: envText(env, id, 'CLIENT_SECRET'),
    scopes,
    scopeParam: connector.scope_param,
    scopeSeparator: connector.scope_separator,
    resource: connector.resource,
  };
  const missing = [];
  if (!config.clientId) missing.push(envName(id, 'CLIENT_ID'));
  if (!config.mcpUrl) missing.push(envName(id, 'MCP_URL'));
  if (!config.authorizeUrl) missing.push(envName(id, 'AUTHORIZE_URL'));
  if (!config.tokenUrl) missing.push(envName(id, 'TOKEN_URL'));
  if (!Array.isArray(config.scopes)) missing.push(envName(id, 'SCOPES'));
  return { ...config, configured: missing.length === 0, missing };
}
