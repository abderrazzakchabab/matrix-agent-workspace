import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { GithubMutationOperation, GithubWriteScope } from '../api/control-plane';

export type MutationConfirmationStatus =
  | 'idle'
  | 'submitting'
  | 'submitted'
  | 'succeeded'
  | 'denied'
  | 'expired'
  | 'failed'
  | 'duplicate';

export interface MutationConfirmationProps {
  repository: string;
  scope: GithubWriteScope;
  operation: GithubMutationOperation;
  /** Normalized argument summary shown verbatim before any mutation is sent. */
  argumentsSummary: ReadonlyArray<{ name: string; value: string }>;
  status: MutationConfirmationStatus;
  commandId?: string | null;
  onConfirm(): void;
  onVerify?(): void;
  onDismiss?(): void;
}

const OPERATION_LABELS: Record<GithubMutationOperation, string> = {
  create_issue: 'create issue',
  update_issue: 'update issue',
  comment_issue: 'comment on issue',
  create_pr_comment: 'comment on pull request',
};

const OPERATION_TITLES: Record<GithubMutationOperation, string> = {
  create_issue: 'Create issue',
  update_issue: 'Update issue',
  comment_issue: 'Comment on issue',
  create_pr_comment: 'Comment on pull request',
};

export function confirmationSentence(
  operation: GithubMutationOperation,
  repository: string,
  scope: GithubWriteScope,
): string {
  return `I confirm ${OPERATION_LABELS[operation]} on ${repository} (${scope})`;
}

const DENIAL_CODES =
  'Mutation denied. The write grant is missing or the approval does not match this exact command.';

function statusMessage(
  status: MutationConfirmationStatus,
  commandId: string | null,
): { role: 'alert' | 'status'; text: string } | null {
  switch (status) {
    case 'submitting':
      return { role: 'status', text: 'Submitting the approved command…' };
    case 'submitted':
      return { role: 'status', text: `Mutation queued.${commandId ? ` Command ${commandId}.` : ''}` };
    case 'succeeded':
      return { role: 'status', text: `Mutation completed.${commandId ? ` Command ${commandId}.` : ''}` };
    case 'denied':
      return { role: 'alert', text: DENIAL_CODES };
    case 'expired':
      return {
        role: 'alert',
        text: 'The approval expired before the mutation ran. Confirm again to record a fresh approval.',
      };
    case 'failed':
      return {
        role: 'alert',
        text: 'The mutation failed. Review the audit history before retrying.',
      };
    case 'duplicate':
      return {
        role: 'status',
        text: `This exact command was already submitted; showing the recorded result.${commandId ? ` Command ${commandId}.` : ''}`,
      };
    default:
      return null;
  }
}

/**
 * Review + explicit-confirmation surface for a Phase C mutation. The scope,
 * repository, and normalized arguments are always visible; the confirmation
 * action is disabled while submitting and after a successful submission.
 * Approval is never inferred — only `onConfirm` sends it.
 */
export function MutationConfirmation({
  repository,
  scope,
  operation,
  argumentsSummary,
  status,
  commandId = null,
  onConfirm,
  onVerify,
  onDismiss,
}: MutationConfirmationProps) {
  const confirmLabel = `Confirm ${OPERATION_LABELS[operation]}`;
  const confirmDisabled = status === 'submitting' || status === 'succeeded';
  const message = statusMessage(status, commandId);

  return (
    <View style={styles.panel}>
      <Text style={styles.eyebrow}>Review mutation</Text>
      <Text style={styles.badge}>{`${repository} · ${scope}`}</Text>
      <Text style={styles.operation}>{OPERATION_TITLES[operation]}</Text>

      <View role="list" accessibilityLabel="Normalized arguments" style={styles.arguments}>
        {argumentsSummary.map((argument) => (
          <View key={argument.name} role="listitem" style={styles.argumentRow}>
            <Text style={styles.argumentName}>{argument.name}</Text>
            <Text style={styles.argumentValue}>{argument.value}</Text>
          </View>
        ))}
      </View>

      <Text style={styles.sentence}>{confirmationSentence(operation, repository, scope)}</Text>

      {message ? (
        <Text
          role={message.role}
          style={message.role === 'alert' ? styles.alert : styles.status}
        >
          {message.text}
        </Text>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={confirmLabel}
        accessibilityState={confirmDisabled ? { disabled: true, busy: status === 'submitting' } : undefined}
        disabled={confirmDisabled}
        onPress={onConfirm}
        style={({ pressed }) => [
          styles.confirmButton,
          confirmDisabled && styles.disabled,
          pressed && !confirmDisabled && styles.pressed,
        ]}
      >
        <Text style={styles.confirmText}>{confirmLabel}</Text>
      </Pressable>

      {status === 'succeeded' && onVerify ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Verify recorded result"
          onPress={onVerify}
          style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
        >
          <Text style={styles.secondaryText}>Verify recorded result</Text>
        </Pressable>
      ) : null}

      {onDismiss && status !== 'submitting' ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to editing"
          onPress={onDismiss}
          style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
        >
          <Text style={styles.secondaryText}>Back to editing</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { backgroundColor: '#ffffff', borderColor: '#bdd2c7', borderRadius: 12, borderWidth: 1, gap: 12, padding: 16 },
  eyebrow: { color: '#4c675a', fontSize: 12, fontWeight: '800', textTransform: 'uppercase' },
  badge: { color: '#225c45', fontSize: 14, fontWeight: '800' },
  operation: { color: '#17201c', fontSize: 20, fontWeight: '800' },
  arguments: { gap: 6 },
  argumentRow: { backgroundColor: '#f2f5f3', borderRadius: 8, gap: 2, padding: 10 },
  argumentName: { color: '#425b50', fontSize: 12, fontWeight: '800', textTransform: 'uppercase' },
  argumentValue: { color: '#17201c', fontSize: 14 },
  sentence: { color: '#26312c', fontSize: 14, fontStyle: 'italic', lineHeight: 20 },
  alert: { backgroundColor: '#fff1f0', borderRadius: 10, color: '#a12c2c', fontSize: 14, lineHeight: 20, padding: 12 },
  status: { backgroundColor: '#eef6f1', borderRadius: 10, color: '#225c45', fontSize: 14, fontWeight: '700', padding: 12 },
  confirmButton: { alignItems: 'center', backgroundColor: '#225c45', borderRadius: 10, justifyContent: 'center', minHeight: 48, paddingHorizontal: 18 },
  confirmText: { color: '#ffffff', fontSize: 15, fontWeight: '800' },
  secondaryButton: { alignItems: 'center', borderColor: '#9fb3a8', borderRadius: 10, borderWidth: 1, justifyContent: 'center', minHeight: 44, paddingHorizontal: 18 },
  secondaryText: { color: '#225c45', fontSize: 14, fontWeight: '700' },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.78 },
});
