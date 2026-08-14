import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import type {
  GithubIssueSummary,
  GithubPullRequestSummary,
} from '../api/control-plane';

export interface GitHubReadPanelProps {
  repository: string;
  issues: readonly GithubIssueSummary[];
  pullRequests: readonly GithubPullRequestSummary[];
  loading?: boolean;
  /** Pre-sanitized message; raw provider/client errors are never rendered. */
  error?: string | null;
}

/**
 * Read-only Phase B panel. Renders repository, issue, and pull-request data
 * only — no mutation controls, no raw provider URLs, and no token material.
 */
export function GitHubReadPanel({
  repository,
  issues,
  pullRequests,
  loading = false,
  error = null,
}: GitHubReadPanelProps) {
  return (
    <View style={styles.panel}>
      <Text style={styles.eyebrow}>GitHub repository · read-only</Text>
      <Text style={styles.title}>{repository}</Text>

      {loading ? (
        <View accessibilityRole="progressbar" accessibilityLabel="Loading GitHub data" style={styles.loading}>
          <ActivityIndicator color="#225c45" />
          <Text style={styles.meta}>Loading GitHub data…</Text>
        </View>
      ) : null}

      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>{error}</Text>
      ) : null}

      {!loading && !error ? (
        <>
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Issues</Text>
            {issues.length === 0 ? (
              <Text style={styles.meta}>No issues returned for this repository.</Text>
            ) : (
              <View role="list" accessibilityLabel="Issues" style={styles.list}>
                {issues.map((issue) => (
                  <View
                    key={issue.id}
                    role="listitem"
                    accessibilityLabel={`Issue #${issue.number}, ${issue.state}`}
                    style={styles.row}
                  >
                    <Text style={styles.rowTitle}>{`Issue #${issue.number}`}</Text>
                    <Text style={styles.rowBody}>{issue.title}</Text>
                    <Text style={styles.meta}>
                      {issue.state}
                      {issue.labels.length > 0 ? ` · ${issue.labels.join(', ')}` : ''}
                    </Text>
                  </View>
                ))}
              </View>
            )}
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Pull requests</Text>
            {pullRequests.length === 0 ? (
              <Text style={styles.meta}>No pull requests returned for this repository.</Text>
            ) : (
              <View role="list" accessibilityLabel="Pull requests" style={styles.list}>
                {pullRequests.map((pullRequest) => (
                  <View
                    key={pullRequest.id}
                    role="listitem"
                    accessibilityLabel={`Pull request #${pullRequest.number}, ${pullRequest.state}`}
                    style={styles.row}
                  >
                    <Text style={styles.rowTitle}>{`Pull request #${pullRequest.number}`}</Text>
                    <Text style={styles.rowBody}>{pullRequest.title}</Text>
                    <Text style={styles.meta}>
                      {`${pullRequest.head} → ${pullRequest.base}`}
                      {pullRequest.draft ? ' · draft' : ''}
                    </Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: 14 },
  eyebrow: { color: '#4c675a', fontSize: 12, fontWeight: '800', textTransform: 'uppercase' },
  title: { color: '#17201c', fontSize: 24, fontWeight: '800' },
  loading: { alignItems: 'center', flexDirection: 'row', gap: 10 },
  error: { backgroundColor: '#fff1f0', borderRadius: 10, color: '#a12c2c', fontSize: 14, lineHeight: 20, padding: 12 },
  section: { gap: 8 },
  sectionTitle: { color: '#26312c', fontSize: 17, fontWeight: '700' },
  list: { gap: 8 },
  row: { backgroundColor: '#ffffff', borderColor: '#d7dcda', borderRadius: 10, borderWidth: 1, gap: 2, padding: 12 },
  rowTitle: { color: '#225c45', fontSize: 13, fontWeight: '800' },
  rowBody: { color: '#17201c', fontSize: 15, fontWeight: '600' },
  meta: { color: '#68716d', fontSize: 12 },
});
