import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as Crypto from 'expo-crypto';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  ControlPlaneError,
  type AuditRecordItem,
  type ControlPlaneApi,
  type GithubIssueSummary,
  type GithubPage,
  type GithubPullRequestSummary,
  type GithubWriteGrantResult,
} from '../api/control-plane';
import { AuditHistory } from '../components/AuditHistory';
import { GitHubReadPanel } from '../components/GitHubReadPanel';
import {
  MutationConfirmation,
  confirmationSentence,
  type MutationConfirmationStatus,
} from '../components/MutationConfirmation';

export interface GitHubWorkspaceScreenProps {
  workspaceId: string;
  /** Approvals are bound to an exact run; mutations stay hidden without one. */
  runId?: string | null;
  /** Preselected `owner/repo`; otherwise the first allowlisted repository. */
  repository?: string;
  /** GitHub App installation linked to the workspace (Phase B). */
  installationId?: string;
  controlPlane: Pick<
    ControlPlaneApi,
    | 'listGithubRepositories'
    | 'listGithubIssues'
    | 'listGithubPullRequests'
    | 'requestGithubWriteGrant'
    | 'createRunApproval'
    | 'enqueueGithubMutation'
    | 'listAuditRecords'
  >;
  createIdempotencyKey?: () => string;
  computeCommandHash?: (
    operation: string,
    args: Record<string, unknown>,
  ) => Promise<string>;
}

type ReadState = 'loading' | 'ready' | 'error' | 'unlinked';

const WRITE_SCOPE = 'issues:write' as const;
const OPERATION = 'create_issue' as const;
const MAX_PAGES = 5;
const READ_ERROR_MESSAGE = 'Unable to load GitHub data. Check your connection and retry.';

/** Error codes that mean the write gate refused the command. */
const DENIAL_CODES = new Set([
  'WRITE_SCOPE_REQUIRED',
  'APPROVAL_DENIED',
  'APPROVAL_MISMATCH',
  'APPROVAL_NOT_FOUND',
  'APPROVAL_CONFIRMATION_REQUIRED',
  'COMMAND_NOT_ALLOWED',
  'RUN_NOT_FOUND',
]);

const defaultIdempotencyKey = () => `mobile_${Crypto.randomUUID()}`;

/** Recursive key sort; must match the control-plane command canonicalization. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** SHA-256 of the canonical command, identical to the server-side hash. */
async function defaultComputeCommandHash(
  operation: string,
  args: Record<string, unknown>,
): Promise<string> {
  const canonical = JSON.stringify(canonicalize({ operation, arguments: args }));
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, canonical);
}

function splitRepository(repository: string): { owner: string; repo: string } {
  const [owner, repo] = repository.split('/');
  if (!owner || !repo) throw new Error('Invalid repository');
  return { owner, repo };
}

/**
 * Approval-driven GitHub collaboration workspace. Renders Phase B read data;
 * mutation controls appear only after an explicit write-grant request, and an
 * approval is recorded only when the user presses the exact confirmation
 * action — never from opening the screen or from Matrix prompt text.
 */
export function GitHubWorkspaceScreen({
  workspaceId,
  runId = null,
  repository,
  installationId,
  controlPlane,
  createIdempotencyKey = defaultIdempotencyKey,
  computeCommandHash = defaultComputeCommandHash,
}: GitHubWorkspaceScreenProps) {
  const [readState, setReadState] = useState<ReadState>('loading');
  const [selectedRepository, setSelectedRepository] = useState<string | null>(repository ?? null);
  const [issues, setIssues] = useState<readonly GithubIssueSummary[]>([]);
  const [pullRequests, setPullRequests] = useState<readonly GithubPullRequestSummary[]>([]);
  const [grant, setGrant] = useState<GithubWriteGrantResult | null>(null);
  const [grantBusy, setGrantBusy] = useState(false);
  const [grantError, setGrantError] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [reviewOpen, setReviewOpen] = useState(false);
  const [mutationState, setMutationState] = useState<MutationConfirmationStatus>('idle');
  const [commandId, setCommandId] = useState<string | null>(null);
  const [auditItems, setAuditItems] = useState<readonly AuditRecordItem[]>([]);
  const [auditLoading, setAuditLoading] = useState(true);
  const pendingMutation = useRef<{
    fingerprint: string;
    idempotencyKey: string;
    approvalId: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchAllPages<T>(
      fetchPage: (cursor?: string) => Promise<GithubPage<T>>,
    ): Promise<T[]> {
      const items: T[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        let result: GithubPage<T>;
        try {
          result = await fetchPage(cursor);
        } catch (error) {
          // A dangling `next` cursor (or a transient failure on a follow-up
          // page) ends pagination with what loaded; the first page failing
          // fails the whole read.
          if (page === 0) throw error;
          break;
        }
        items.push(...result.items);
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
      return items;
    }

    async function load(): Promise<void> {
      if (!installationId) {
        if (!cancelled) setReadState('unlinked');
        return;
      }
      if (!cancelled) setReadState('loading');
      try {
        let selected = repository ?? null;
        if (!selected) {
          const page = await controlPlane.listGithubRepositories({ workspaceId, installationId });
          selected = page.items[0]?.fullName ?? null;
        }
        if (!selected) {
          if (!cancelled) {
            setSelectedRepository(null);
            setIssues([]);
            setPullRequests([]);
            setReadState('ready');
          }
          return;
        }
        const { owner, repo } = splitRepository(selected);
        const [issueItems, pullRequestItems] = await Promise.all([
          fetchAllPages((cursor) =>
            controlPlane.listGithubIssues({ workspaceId, installationId, owner, repo, cursor })),
          fetchAllPages((cursor) =>
            controlPlane.listGithubPullRequests({ workspaceId, installationId, owner, repo, cursor })),
        ]);
        if (cancelled) return;
        setSelectedRepository(selected);
        setIssues(issueItems);
        setPullRequests(pullRequestItems);
        setReadState('ready');
      } catch {
        if (!cancelled) setReadState('error');
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [controlPlane, workspaceId, installationId, repository]);

  const loadAudit = useCallback(async () => {
    setAuditLoading(true);
    try {
      const page = await controlPlane.listAuditRecords(workspaceId);
      setAuditItems(page.items);
    } catch {
      // Keep the previous trail; audit unavailability never blocks reads.
    } finally {
      setAuditLoading(false);
    }
  }, [controlPlane, workspaceId]);

  useEffect(() => {
    void loadAudit();
  }, [loadAudit]);

  async function requestGrant(): Promise<void> {
    if (!selectedRepository || grantBusy) return;
    setGrantBusy(true);
    setGrantError(false);
    try {
      setGrant(await controlPlane.requestGithubWriteGrant(workspaceId, selectedRepository, WRITE_SCOPE));
    } catch {
      setGrantError(true);
    } finally {
      setGrantBusy(false);
    }
  }

  function mutationArguments(): Record<string, unknown> {
    const args: Record<string, unknown> = { title: title.trim() };
    if (body.trim().length > 0) args.body = body.trim();
    return args;
  }

  function mapMutationError(error: unknown): MutationConfirmationStatus {
    const code = error instanceof ControlPlaneError ? error.code : undefined;
    if (code === 'APPROVAL_EXPIRED') return 'expired';
    if (code && DENIAL_CODES.has(code)) return 'denied';
    return 'failed';
  }

  function applyMutationResult(result: { commandId: string; status: string; replayed: boolean }): void {
    setCommandId(result.commandId);
    if (result.replayed) setMutationState('duplicate');
    else if (result.status === 'completed') setMutationState('succeeded');
    else if (result.status === 'failed') setMutationState('failed');
    else setMutationState('submitted');
  }

  async function confirmMutation(): Promise<void> {
    if (!selectedRepository || !runId) return;
    if (mutationState === 'submitting' || mutationState === 'succeeded') return;
    const args = mutationArguments();
    setMutationState('submitting');
    try {
      const commandHash = await computeCommandHash(OPERATION, args);
      // The explicit approval is recorded only here, on the confirm action.
      const approval = await controlPlane.createRunApproval(runId, {
        scope: WRITE_SCOPE,
        decision: 'approved',
        confirmationText: confirmationSentence(OPERATION, selectedRepository, WRITE_SCOPE),
        commandHash,
      });
      const fingerprint = JSON.stringify({
        repository: selectedRepository,
        operation: OPERATION,
        arguments: args,
      });
      const idempotencyKey = pendingMutation.current?.fingerprint === fingerprint
        ? pendingMutation.current.idempotencyKey
        : createIdempotencyKey();
      pendingMutation.current = { fingerprint, idempotencyKey, approvalId: approval.approvalId };
      const result = await controlPlane.enqueueGithubMutation(workspaceId, {
        idempotencyKey,
        approvalId: approval.approvalId,
        repository: selectedRepository,
        runId,
        operation: OPERATION,
        arguments: args,
      });
      applyMutationResult(result);
    } catch (error) {
      setMutationState(mapMutationError(error));
    } finally {
      void loadAudit();
    }
  }

  async function verifyRecordedResult(): Promise<void> {
    const pending = pendingMutation.current;
    if (!selectedRepository || !pending || mutationState === 'submitting') return;
    setMutationState('submitting');
    try {
      const result = await controlPlane.enqueueGithubMutation(workspaceId, {
        idempotencyKey: pending.idempotencyKey,
        approvalId: pending.approvalId,
        repository: selectedRepository,
        ...(runId ? { runId } : {}),
        operation: OPERATION,
        arguments: mutationArguments(),
      });
      applyMutationResult(result);
    } catch (error) {
      setMutationState(mapMutationError(error));
    } finally {
      void loadAudit();
    }
  }

  const canReview = Boolean(runId && title.trim().length > 0);
  const argumentsSummary = [
    { name: 'title', value: title.trim() },
    ...(body.trim().length > 0 ? [{ name: 'body', value: body.trim() }] : []),
  ];

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text style={styles.eyebrow}>Collaboration workspace</Text>
          <Text style={styles.title}>GitHub workspace</Text>
          <Text style={styles.description}>
            Read data is always available to authorized sessions. Writes require a
            separate grant and your explicit confirmation.
          </Text>
        </View>

        {readState === 'loading' ? (
          <View accessibilityRole="progressbar" accessibilityLabel="Loading GitHub data" style={styles.loadingRow}>
            <ActivityIndicator color="#225c45" />
            <Text style={styles.meta}>Loading GitHub data…</Text>
          </View>
        ) : null}

        {readState === 'unlinked' ? (
          <Text style={styles.meta}>
            No GitHub App installation is linked to this workspace yet.
          </Text>
        ) : null}

        {readState === 'error' ? (
          <Text accessibilityRole="alert" style={styles.errorPanel}>{READ_ERROR_MESSAGE}</Text>
        ) : null}

        {readState === 'ready' && !selectedRepository ? (
          <Text style={styles.meta}>
            No repositories are available for this installation.
          </Text>
        ) : null}

        {readState === 'ready' && selectedRepository ? (
          <>
            <GitHubReadPanel
              repository={selectedRepository}
              issues={issues}
              pullRequests={pullRequests}
            />

            {!grant ? (
              <View style={styles.section}>
                {grantError ? (
                  <Text accessibilityRole="alert" style={styles.errorPanel}>
                    Unable to request write access. Check your connection and retry.
                  </Text>
                ) : null}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Request write access"
                  accessibilityState={grantBusy ? { busy: true } : undefined}
                  disabled={grantBusy}
                  onPress={requestGrant}
                  style={({ pressed }) => [
                    styles.secondaryButton,
                    grantBusy && styles.disabled,
                    pressed && !grantBusy && styles.pressed,
                  ]}
                >
                  <Text style={styles.secondaryButtonText}>Request write access</Text>
                </Pressable>
              </View>
            ) : null}

            {grant && grant.status === 'revoked' ? (
              <Text accessibilityRole="alert" style={styles.errorPanel}>
                The write grant for this repository was revoked.
              </Text>
            ) : null}

            {grant && grant.status !== 'revoked' && !reviewOpen ? (
              <View style={styles.section}>
                <Text style={styles.grantBadge}>{`${selectedRepository} · ${grant.scope}`}</Text>
                <Text style={styles.meta}>
                  {grant.status === 'approved'
                    ? 'Write grant approved.'
                    : 'Write grant pending approval.'}
                </Text>
                {!runId ? (
                  <Text accessibilityRole="alert" style={styles.errorPanel}>
                    Open this workspace from a run to approve mutations.
                  </Text>
                ) : (
                  <>
                    <View style={styles.field}>
                      <Text style={styles.label}>Issue title</Text>
                      <TextInput
                        accessibilityLabel="Issue title"
                        placeholder="Title for the new issue"
                        style={styles.input}
                        value={title}
                        onChangeText={setTitle}
                      />
                    </View>
                    <View style={styles.field}>
                      <Text style={styles.label}>Issue body</Text>
                      <TextInput
                        accessibilityLabel="Issue body"
                        multiline
                        placeholder="Optional body text"
                        style={[styles.input, styles.bodyInput]}
                        textAlignVertical="top"
                        value={body}
                        onChangeText={setBody}
                      />
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Review create issue"
                      accessibilityState={canReview ? undefined : { disabled: true }}
                      disabled={!canReview}
                      onPress={() => {
                        setMutationState('idle');
                        setCommandId(null);
                        setReviewOpen(true);
                      }}
                      style={({ pressed }) => [
                        styles.primaryButton,
                        !canReview && styles.disabled,
                        pressed && canReview && styles.pressed,
                      ]}
                    >
                      <Text style={styles.primaryButtonText}>Review create issue</Text>
                    </Pressable>
                  </>
                )}
              </View>
            ) : null}

            {grant && grant.status !== 'revoked' && reviewOpen && runId ? (
              <MutationConfirmation
                repository={selectedRepository}
                scope={grant.scope}
                operation={OPERATION}
                argumentsSummary={argumentsSummary}
                status={mutationState}
                commandId={commandId}
                onConfirm={confirmMutation}
                onVerify={verifyRecordedResult}
                onDismiss={() => setReviewOpen(false)}
              />
            ) : null}
          </>
        ) : null}

        <AuditHistory items={auditItems} loading={auditLoading} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { backgroundColor: '#f7f7f5', flex: 1 },
  content: { gap: 22, padding: 20, paddingBottom: 38 },
  header: { gap: 6 },
  eyebrow: { color: '#4c675a', fontSize: 12, fontWeight: '800', textTransform: 'uppercase' },
  title: { color: '#17201c', fontSize: 28, fontWeight: '800' },
  description: { color: '#58615d', fontSize: 15, lineHeight: 22 },
  loadingRow: { alignItems: 'center', flexDirection: 'row', gap: 10 },
  meta: { color: '#68716d', fontSize: 13 },
  errorPanel: { backgroundColor: '#fff1f0', borderRadius: 10, color: '#a12c2c', fontSize: 14, lineHeight: 20, padding: 12 },
  section: { gap: 12 },
  field: { gap: 6 },
  label: { color: '#26312c', fontSize: 14, fontWeight: '600' },
  input: { backgroundColor: '#ffffff', borderColor: '#cbd1ce', borderRadius: 10, borderWidth: 1, color: '#17201c', fontSize: 16, paddingHorizontal: 14, paddingVertical: 12 },
  bodyInput: { minHeight: 96 },
  grantBadge: { color: '#225c45', fontSize: 14, fontWeight: '800' },
  primaryButton: { alignItems: 'center', backgroundColor: '#225c45', borderRadius: 10, justifyContent: 'center', minHeight: 48, paddingHorizontal: 18 },
  primaryButtonText: { color: '#ffffff', fontSize: 15, fontWeight: '800' },
  secondaryButton: { alignItems: 'center', borderColor: '#225c45', borderRadius: 10, borderWidth: 1, justifyContent: 'center', minHeight: 46, paddingHorizontal: 18 },
  secondaryButtonText: { color: '#225c45', fontSize: 15, fontWeight: '800' },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.78 },
});
