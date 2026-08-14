import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import type { AuditRecordItem } from '../api/control-plane';

export interface AuditHistoryProps {
  items: readonly AuditRecordItem[];
  loading?: boolean;
}

const REDACTED = '[REDACTED]';

/**
 * Append-only audit trail. Payload details are rendered redacted client-side
 * as well (the server stores `[REDACTED]` too), so tokens, confirmation text,
 * and argument bodies never reach the UI even if a row is malformed.
 */
export function AuditHistory({ items, loading = false }: AuditHistoryProps) {
  return (
    <View style={styles.panel}>
      <Text style={styles.title}>Audit history</Text>
      <Text style={styles.meta}>Payloads are stored and displayed redacted.</Text>

      {loading ? (
        <View accessibilityRole="progressbar" accessibilityLabel="Loading audit history" style={styles.loading}>
          <ActivityIndicator color="#225c45" />
          <Text style={styles.meta}>Loading audit history…</Text>
        </View>
      ) : null}

      {!loading && items.length === 0 ? (
        <Text style={styles.meta}>No audit records yet.</Text>
      ) : null}

      {!loading && items.length > 0 ? (
        <View role="list" accessibilityLabel="Audit records" style={styles.list}>
          {items.map((item) => {
            const detailKeys = Object.keys(item.details ?? {});
            return (
              <View
                key={item.id}
                role="listitem"
                accessibilityLabel={`${item.outcome}, ${item.scope ?? 'workspace'}`}
                style={styles.row}
              >
                <Text style={styles.outcome}>{item.outcome}</Text>
                <Text style={styles.rowMeta}>
                  {`${item.repository ?? 'workspace'} · ${item.scope ?? 'no scope'}`}
                </Text>
                {item.operation ? (
                  <Text style={styles.rowMeta}>{`Operation: ${item.operation}`}</Text>
                ) : null}
                <Text style={styles.rowMeta}>{item.createdAt}</Text>
                {detailKeys.map((key) => (
                  <Text key={key} style={styles.redacted}>{`${key}: ${REDACTED}`}</Text>
                ))}
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: 8 },
  title: { color: '#26312c', fontSize: 17, fontWeight: '700' },
  loading: { alignItems: 'center', flexDirection: 'row', gap: 10 },
  list: { gap: 8 },
  row: { backgroundColor: '#ffffff', borderColor: '#d7dcda', borderRadius: 10, borderWidth: 1, gap: 2, padding: 12 },
  outcome: { color: '#17201c', fontSize: 15, fontWeight: '700' },
  rowMeta: { color: '#68716d', fontSize: 12 },
  redacted: { color: '#8a6d16', fontFamily: 'monospace', fontSize: 12 },
  meta: { color: '#68716d', fontSize: 12 },
});
