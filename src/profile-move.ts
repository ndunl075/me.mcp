/**
 * Handle moves for sign-in: a GitHub rename must carry the person's data to the new handle, and a stale row (one whose
 * GitHub account no longer owns the login) must be parked somewhere unreachable instead of being deleted or inherited.
 *
 * Everything returns prepared statements for the caller to run in ONE D1 batch (a transaction), so a failure can't leave
 * half-moved data.
 */

/** Tables keyed by (handle, ...) that are not covered by a foreign key. */
const HANDLE_TABLES = ["call_daily", "call_clients", "activity", "sources"] as const;

/**
 * Where a stale row is parked: `~<github_id>`. GitHub logins are letters, digits and single hyphens, so a `~` handle can
 * never be a real login, and github_id is unique so two parked rows can never collide. The row is unpublished, so no
 * page, MCP server, search, card or listing serves it, and cron never refreshes it. When its real owner signs in under
 * their new login, the rename path moves it from here.
 */
export function placeholderHandle(githubId: number): string {
  return `~${githubId}`;
}

/**
 * Statements that move everything stored under `from` to `to`: the profile row (all fields, key hash and calls_total
 * included, by renaming its primary key) plus call_daily, call_clients, activity and sources. `to` must not hold a profile.
 * Rows left over under `to` from earlier deletions are cleared first so a primary-key clash can't abort the move.
 *
 * share_cards references profiles(handle) ON DELETE CASCADE with no ON UPDATE action, so the key can't change while a
 * card exists. The card is dropped (a card is drawn from the profile and the owner's browser redraws it on the next
 * visit, keyed to the new handle's URL) rather than fighting the foreign key.
 */
export function moveHandleStatements(db: D1Database, from: string, to: string, opts: { unpublish?: boolean } = {}): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [db.prepare("DELETE FROM share_cards WHERE handle IN (?, ?)").bind(from, to)];
  for (const t of HANDLE_TABLES) stmts.push(db.prepare(`DELETE FROM ${t} WHERE handle = ?`).bind(to));
  stmts.push(
    db
      .prepare(`UPDATE profiles SET handle = ?${opts.unpublish ? ", published = 0" : ""} WHERE handle = ?`)
      .bind(to, from),
  );
  for (const t of HANDLE_TABLES) stmts.push(db.prepare(`UPDATE ${t} SET handle = ? WHERE handle = ?`).bind(to, from));
  return stmts;
}
