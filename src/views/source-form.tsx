import { SOURCE_DISABLE_AFTER, type CustomSourceRow } from "../activity";
import type { CustomKind } from "../custom-sources";

const KIND_LABEL: Record<CustomKind, string> = {
  website: "Website",
  feed: "Feed",
  hn: "Hacker News",
  devto: "dev.to",
  npm: "npm",
};

/** Add / remove owner-added sources. `back` says which page the form returns to. */
export function SourceForms({ base, back, sources }: { base: string; back: "edit" | "profile"; sources: CustomSourceRow[] }) {
  return (
    <div class="added-sources">
      {sources.map((s) => {
        const broken = !s.enabled && s.failures >= SOURCE_DISABLE_AFTER;
        const name = KIND_LABEL[s.kind as CustomKind] ?? s.kind;
        return (
          <div class="src-row static">
            <span class="src-name">
              {name} {s.label && <small>{s.label}</small>}
              {!s.verified && s.enabled && <em>Add a link to your me.mcp page or GitHub profile on it to verify.</em>}
              {broken && <em>Turned off after repeated failures</em>}
            </span>
            <form method="post" action={`${base}/edit/sources/remove`}>
              <input type="hidden" name="id" value={s.id} />
              <input type="hidden" name="back" value={back} />
              <button class="btn btn-sm btn-light" type="submit">
                Remove
              </button>
            </form>
          </div>
        );
      })}
      {sources.length < 6 && (
        <form method="post" action={`${base}/edit/sources/add`} class="add-src">
          <input type="hidden" name="back" value={back} />
          <select name="kind" aria-label="Source type">
            <option value="website">Website</option>
            <option value="feed">Feed URL</option>
            <option value="hn">Hacker News</option>
            <option value="devto">dev.to</option>
            <option value="npm">npm</option>
          </select>
          <input type="text" name="target" required maxlength={300} placeholder="Username or https:// URL" aria-label="Source" />
          <button class="btn btn-sm btn-dark" type="submit">
            Add
          </button>
        </form>
      )}
      <p class="hint" style="margin-top:8px">
        Unverified sources still show, marked unverified, until they link to your GitHub profile or your me.mcp page.
      </p>
    </div>
  );
}
