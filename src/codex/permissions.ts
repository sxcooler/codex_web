import { isDeepStrictEqual } from 'node:util';

export type PermissionMode = 'ask' | 'auto-review' | 'full-access' | 'custom';
export type PermissionPolicy = { approvalPolicy: any; approvalsReviewer: string; sandbox: any; mode?: PermissionMode };

export function permissionChoices(cwd: string, config: any, requirements: any, platform?: string) {
  const workspace = { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true };
  const ws = config.sandbox_workspace_write;
  const validWorkspace = Array.isArray(ws?.writable_roots) && ws.writable_roots.every((root: unknown) => typeof root === 'string') && ['network_access', 'exclude_tmpdir_env_var', 'exclude_slash_tmp'].every(key => typeof ws[key] === 'boolean');
  const customSandbox = config.sandbox_mode === 'danger-full-access' ? { type: 'dangerFullAccess' }
    : config.sandbox_mode === 'read-only' ? { type: 'readOnly', networkAccess: false }
    : config.sandbox_mode === 'workspace-write' && validWorkspace ? {
      type: 'workspaceWrite', writableRoots: [...new Set([cwd, ...config.sandbox_workspace_write.writable_roots])],
      networkAccess: config.sandbox_workspace_write.network_access,
      excludeTmpdirEnvVar: config.sandbox_workspace_write.exclude_tmpdir_env_var,
      excludeSlashTmp: config.sandbox_workspace_write.exclude_slash_tmp,
    } : null;
  const policies: Record<PermissionMode, PermissionPolicy> = {
    ask: { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: workspace },
    'auto-review': { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: workspace },
    'full-access': { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'dangerFullAccess' } },
    custom: { approvalPolicy: config.approval_policy, approvalsReviewer: config.approvals_reviewer, sandbox: customSandbox },
  };
  const modes = (Object.keys(policies) as PermissionMode[]).map(id => {
    const policy = policies[id];
    let reason: string | undefined;
    if (!policy.sandbox || !policy.approvalPolicy || !['user', 'auto_review'].includes(policy.approvalsReviewer)
      || (id === 'custom' && (config.permissions || config.default_permissions))) reason = 'Native custom permissions cannot be represented by this protocol';
    const sandboxMode = sandboxName(policy.sandbox);
    if (requirements?.allowedSandboxModes && !requirements.allowedSandboxModes.includes(sandboxMode)) reason = 'Sandbox restricted by managed requirements';
    if (requirements?.allowedApprovalPolicies && !requirements.allowedApprovalPolicies.some((p: any) => isDeepStrictEqual(p, policy.approvalPolicy))) reason = 'Approval policy restricted by managed requirements';
    if (requirements?.allowedPermissionProfiles || requirements?.defaultPermissions) reason = 'Managed permission profiles require a compatible native protocol';
    if (policy.approvalsReviewer === 'auto_review' && (config.features?.auto_review === false || requirements?.featureRequirements?.auto_review === false)) reason = 'Automatic review is disabled by native configuration';
    if (platform === 'windows' && policy.sandbox?.type !== 'dangerFullAccess' && config.windows?.sandbox === 'disabled') reason = 'Windows sandbox is disabled';
    return { id, available: !reason, ...(reason ? { reason } : {}), summary: { approvalPolicy: policy.approvalPolicy ?? null, approvalsReviewer: policy.approvalsReviewer ?? null, sandbox: sandboxMode, networkAccess: policy.sandbox?.type === 'dangerFullAccess' || policy.sandbox?.networkAccess === true } };
  });
  const current = modes.find(m => m.id !== 'custom' && isDeepStrictEqual(policies[m.id], policies.custom))?.id ?? 'custom';
  return { modes, current, policies };
}

export function sandboxName(sandbox: any): string | null {
  return ({ workspaceWrite: 'workspace-write', dangerFullAccess: 'danger-full-access', readOnly: 'read-only' } as Record<string, string>)[sandbox?.type] ?? null;
}

export function threadPermissionOptions(policy: PermissionPolicy) {
  const sandbox = policy.sandbox;
  return { approvalPolicy: policy.approvalPolicy, approvalsReviewer: policy.approvalsReviewer, sandbox: sandboxName(sandbox),
    ...(sandbox.type === 'workspaceWrite' ? { config: { sandbox_workspace_write: {
      writable_roots: sandbox.writableRoots, network_access: sandbox.networkAccess,
      exclude_tmpdir_env_var: sandbox.excludeTmpdirEnvVar, exclude_slash_tmp: sandbox.excludeSlashTmp,
    } } } : {}) };
}
