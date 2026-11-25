// graph-helpers.ts — 图行读取、结果落点（resultPlacement /
// placeResult）、结果落地与资产登记、节点运行状态标记。
// 拆分来源：批次 S1 从 server/src/actions.ts 整段搬移，行为不变

import { type Ctx } from "@hatch/space-sdk";
import { Contracts } from "@space/privileged";
import { and, eq, isNull } from "drizzle-orm";
import * as schema from "../schema";
import type { Db, NodeRow, ProjectRow } from "./contracts";
import { recordGenerationOutcome } from "./generation-records";
import { reserveNodeSeqs } from "./project-dirs";
import {
  cardSizeForRatio,
  measuredCardSize,
  normalizeImageRatio,
} from "./ratios";

// Graph helpers: rows, result placement, generation context

export async function getNodeRow(db: Db, nodeId: string): Promise<NodeRow | null> {
const rows = await db
.select()
.from(schema.canvasNodes)
.where(eq(schema.canvasNodes.id, nodeId))
.limit(1);
return rows[0]?? null;
}

export async function getProjectRow(db: Db, projectId: string): Promise<ProjectRow | null> {
const rows = await db
.select()
.from(schema.projects)
.where(eq(schema.projects.id, projectId))
.limit(1);
return rows[0]?? null;
}

export function resultPlacement(
source: NodeRow,
kind: NodeRow["type"],
genSize?: string | null,
): { x: number; y: number; width: number; height: number} {
if (kind === "audio") {
return { x: source.x + source.width + 72, y: source.y, width: 340, height: 120};
}
if (kind === "text") {
return { x: source.x + source.width + 72, y: source.y, width: 340, height: 240};
}
if (kind === "video") {
// A measured genSize wins over the requested ratio: the frame must
// match the finished file's real proportions.
const s = measuredCardSize(genSize, "video") ?? cardSizeForRatio(source.genRatio, 420, { w: 420, h: 236});
return { x: source.x + source.width + 72, y: source.y, width: s.w, height: s.h};
}
const s = measuredCardSize(genSize, "image") ?? cardSizeForRatio(source.genRatio, 320, { w: 320, h: 320});
return { x: source.x + source.width + 72, y: source.y, width: s.w, height: s.h};
}

/** Placement for a result node. The preferred spot is immediately
 * right of the source (dx = source.width + 72, dy = 0) — that stays
 * the empty-column baseline, unchanged. When the preferred spot is
 * taken, search a BOUNDED grid of nearby candidates instead of the
 * old single-column push (same x, y += height + 28, up to 40 steps 
 * on a dense canvas that exiled results thousands of pixels below
 * the source, farther with every repeat run): columns step right by
 * (result width + 48), rows step down by (result height + 28), 3
 * columns × 4 rows, and the free candidate nearest the preferred
 * spot wins. When every candidate in range is taken, the result
 * lands on the preferred spot anyway — a slight overlap beats a
 * node exiled out of sight.
 *
 * The anchor is re-read at landing time: runs are async (prompt-
 * reverse inference can take up to two minutes), and the source row
 * the caller holds may predate a mid-run drag of the source node. */
type Rect = { x: number; y: number; width: number; height: number };

/** Finds the nearest non-overlapping (x, y) on a bounded 3×4 grid
 * starting from (baseX, baseY). Falls back to (baseX, baseY) when
 * every candidate in range is occupied. */
export function findFreeSpot(
  baseX: number,
  baseY: number,
  width: number,
  height: number,
  siblings: Rect[],
): { x: number; y: number } {
  const overlaps = (xx: number, yy: number) =>
    siblings.some(
      (s) =>
        xx < s.x + s.width &&
        xx + width > s.x &&
        yy < s.y + s.height &&
        yy + height > s.y,
    );
  if (!overlaps(baseX, baseY)) {
    return { x: baseX, y: baseY };
  }
  const stepX = width + 48;
  const stepY = height + 28;
  const candidates: { x: number; y: number; dist2: number }[] = [];
  for (let col = 0; col <= 2; col += 1) {
    for (let row = 0; row <= 3; row += 1) {
      if (col === 0 && row === 0) continue;
      const dx = col * stepX;
      const dy = row * stepY;
      candidates.push({
        x: baseX + dx,
        y: baseY + dy,
        dist2: dx * dx + dy * dy,
      });
    }
  }
  candidates.sort((a, b) => a.dist2 - b.dist2);
  for (const candidate of candidates) {
    if (!overlaps(candidate.x, candidate.y)) {
      return { x: candidate.x, y: candidate.y };
    }
  }
  return { x: baseX, y: baseY };
}

export async function placeResult(
db: Db,
source: NodeRow,
kind: NodeRow["type"],
genSize?: string | null,
): Promise<{ x: number; y: number; width: number; height: number}> {
const anchor = (await getNodeRow(db, source.id)) ?? source;
const place = resultPlacement(anchor, kind, genSize);
const siblings = await db
.select({
x: schema.canvasNodes.x,
y: schema.canvasNodes.y,
width: schema.canvasNodes.width,
height: schema.canvasNodes.height,
})
.from(schema.canvasNodes)
.where(eq(schema.canvasNodes.projectId, anchor.projectId));
const spot = findFreeSpot(place.x, place.y, place.width, place.height, siblings);
return { ...place, x: spot.x, y: spot.y };
}

export async function attachResultNode(
db: Db,
source: NodeRow,
fields: MediaResultFields,
): Promise<string> {
const place = await placeResult(db, source, fields.type, fields.genSize);
const resultId = fields.id?? crypto.randomUUID();
const now = new Date();
const countRows = await db
.select({ id: schema.canvasNodes.id})
.from(schema.canvasNodes)
.where(eq(schema.canvasNodes.projectId, source.projectId));
const [resultSeq] = await reserveNodeSeqs(db, source.projectId, 1);
await db.insert(schema.canvasNodes).values({
id: resultId,
projectId: source.projectId,
seq: resultSeq?? null,
type: fields.type,
title: fields.title,
x: place.x,
y: place.y,
width: place.width,
height: place.height,
content: fields.content,
prompt: fields.prompt?? "",
status: "success",
hidden: false,
groupId: null,
color: null,
genStatus: "idle",
genRatio:
fields.type === "image"
? normalizeImageRatio(source.genRatio)
: fields.type === "video"
? (source.genRatio?? "16:9")
: null,
genSize: fields.genSize?? null,
genDuration:
fields.type === "video"
? source.genDuration
: fields.type === "audio" && fields.durationSeconds != null
? Math.round(fields.durationSeconds)
: null,
genKind:
fields.type === "image"
? "image"
: fields.type === "video"
? "video"
: fields.type === "audio"
? "audio"
: null,
mediaBlobKey: fields.mediaBlobKey,
mimeType: fields.mimeType,
filePath: fields.filePath,
posterBlobKey: fields.posterBlobKey ?? null,
sortOrder: countRows.length,
createdAt: now,
updatedAt: now,
});
await db.insert(schema.canvasEdges).values({
id: crypto.randomUUID(),
projectId: source.projectId,
fromNodeId: source.id,
toNodeId: resultId,
sortOrder: 0,
createdAt: now,
});
await db
.update(schema.canvasNodes)
.set({
genStatus: "done",
genError: null,
genTaskId: null,
genClaimToken: null,
genStartedAt: null,
status: "success",
updatedAt: now,
})
.where(eq(schema.canvasNodes.id, source.id));
await db
.update(schema.projects)
.set({ updatedAt: now})
.where(eq(schema.projects.id, source.projectId));
// Terminal path: this run just settled done — write its history row
// (a no-op when the run was not in flight, or when the enclosing
// landMediaResult already recorded it: same idempotency key).
if (source.genStatus === "queued" || source.genStatus === "working") {
await recordGenerationOutcome(db, source, {
status: "done",
resultNodeId: resultId,
mediaBlobKey: fields.mediaBlobKey,
mimeType: fields.mimeType,
filePath: fields.filePath,
genSize: fields.genSize ?? null,
prompt: fields.recordPrompt ?? fields.prompt,
});
}
return resultId;
}

export type MediaResultFields = {
  id?: string;
  type: NodeRow["type"];
  title: string;
  content: string;
  prompt?: string;
  /** Assembled generation prompt recorded into history/assets without overwriting the node's own editable prompt. */
  recordPrompt?: string;
  mediaBlobKey: string | null;
  mimeType: string | null;
  filePath: string | null;
  genSize?: string | null;
  durationSeconds?: number | null;
  posterBlobKey?: string | null;
};

/** In-place delivery: a media node that generated its OWN kind (an
 * image placeholder generating an image, a video node a video, an
 * audio node audio) receives the result itself — same id, position
 * and edges; only the media payload, measured size and run state
 * change. The node frame adopts the MEASURED genSize's aspect ratio
 * (falling back to the requested ratio while no measurement exists,
 * e.g. the direct image path whose probe lands in the
 * mirror step — mirrorNodeMedia re-applies the measured frame
 * there), so the filled media displays at its real proportions,
 * never cropped into the placeholder's old frame. A stale video
 * poster is cleared so ensurePoster re-grabs a frame from the new
 * file. */
export async function fillResultIntoNode(
  db: Db,
  source: NodeRow,
  fields: MediaResultFields,
): Promise<string> {
  const anchor = (await getNodeRow(db, source.id)) ?? source;
  const place = resultPlacement(anchor, fields.type, fields.genSize);
  let nextX = anchor.x;
  let nextY = anchor.y;
  if (place.width > anchor.width || place.height > anchor.height) {
    const rows = await db
      .select({
        id: schema.canvasNodes.id,
        type: schema.canvasNodes.type,
        hidden: schema.canvasNodes.hidden,
        x: schema.canvasNodes.x,
        y: schema.canvasNodes.y,
        width: schema.canvasNodes.width,
        height: schema.canvasNodes.height,
      })
      .from(schema.canvasNodes)
      .where(eq(schema.canvasNodes.projectId, anchor.projectId));
    const siblings = rows.filter(
      (r) => r.id !== anchor.id && r.type !== "group" && !r.hidden,
    );
    const spot = findFreeSpot(anchor.x, anchor.y, place.width, place.height, siblings);
    nextX = spot.x;
    nextY = spot.y;
  }
  const now = new Date();
  await db
    .update(schema.canvasNodes)
    .set({
      x: nextX,
      y: nextY,
      width: place.width,
      height: place.height,
      content: "",
      prompt: fields.prompt ?? source.prompt,
      status: "success",
      genStatus: "done",
      genError: null,
      genTaskId: null,
      genClaimToken: null,
      genStartedAt: null,
      genSize: fields.genSize ?? source.genSize,
      genDuration:
        fields.type === "audio" && fields.durationSeconds != null
          ? Math.round(fields.durationSeconds)
          : source.genDuration,
      genKind:
        fields.type === "image"
          ? "image"
          : fields.type === "video"
            ? "video"
            : fields.type === "audio"
              ? "audio"
              : source.genKind,
      mediaBlobKey: fields.mediaBlobKey,
      mimeType: fields.mimeType,
      filePath: fields.filePath,
      posterBlobKey: fields.posterBlobKey ?? null,
      // A stale playback proxy belongs to the previous file: clear it
      // with the poster so ensureProxy re-transcodes from the new one.
      proxyBlobKey: null,
      updatedAt: now,
    })
    .where(eq(schema.canvasNodes.id, source.id));
  await db
    .update(schema.projects)
    .set({ updatedAt: now })
    .where(eq(schema.projects.id, source.projectId));
  return source.id;
}

/** Forks a parallel sibling node directly below `source` (inheriting
 * its prompt, ratio/duration settings, and all incoming edges from
 * upstream nodes) when regenerating a media node that already holds
 * a finished result. Blank placeholders and failed retries still run
 * in-place on `source` itself. */
export async function forkSiblingForRegen(
  db: Db,
  source: NodeRow,
): Promise<NodeRow> {
  if (
    !source.mediaBlobKey ||
    (source.type !== "image" &&
      source.type !== "video" &&
      source.type !== "audio")
  ) {
    return source;
  }
  const siblings = await db
    .select({
      x: schema.canvasNodes.x,
      y: schema.canvasNodes.y,
      width: schema.canvasNodes.width,
      height: schema.canvasNodes.height,
    })
    .from(schema.canvasNodes)
    .where(eq(schema.canvasNodes.projectId, source.projectId));
  const stepY = source.height + 28;
  let chosenY = source.y + stepY;
  for (let row = 1; row <= 20; row += 1) {
    const yy = source.y + row * stepY;
    const hit = siblings.some(
      (s) =>
        source.x < s.x + s.width &&
        source.x + source.width > s.x &&
        yy < s.y + s.height &&
        yy + source.height > s.y,
    );
    if (!hit) {
      chosenY = yy;
      break;
    }
  }
  const newId = crypto.randomUUID();
  const now = new Date();
  const [newSeq] = await reserveNodeSeqs(db, source.projectId, 1);
  await db.insert(schema.canvasNodes).values({
    id: newId,
    projectId: source.projectId,
    seq: newSeq ?? null,
    type: source.type,
    title: source.title,
    x: source.x,
    y: chosenY,
    width: source.width,
    height: source.height,
    content: source.content,
    prompt: source.prompt,
    status: "idle",
    hidden: false,
    groupId: source.groupId,
    color: source.color,
    genStatus: "idle",
    genRatio: source.genRatio,
    genSize: null,
    genDuration: source.genDuration,
    genKind: source.genKind,
    mediaBlobKey: null,
    mimeType: null,
    filePath: null,
    posterBlobKey: null,
    proxyBlobKey: null,
    sortOrder: siblings.length,
    createdAt: now,
    updatedAt: now,
  });
  const incoming = await db
    .select()
    .from(schema.canvasEdges)
    .where(eq(schema.canvasEdges.toNodeId, source.id));
  for (const edge of incoming) {
    await db.insert(schema.canvasEdges).values({
      id: crypto.randomUUID(),
      projectId: source.projectId,
      fromNodeId: edge.fromNodeId,
      toNodeId: newId,
      sortOrder: edge.sortOrder,
      createdAt: now,
    });
  }
  return (await getNodeRow(db, newId)) ?? source;
}

/** Lands a generated media result: into the source node itself when
 * the source IS a node of the result's kind (the placeholder the user
 * ran — no new node, no new edge), otherwise as a fresh result node
 * beside it (config hubs and cross-kind runs keep the fan-out shape).
 * Returns the id of the node that now carries the media. */
export async function landMediaResult(
  db: Db,
  source: NodeRow,
  fields: MediaResultFields,
): Promise<string> {
  const landedId =
    source.type === fields.type
      ? await fillResultIntoNode(db, source, fields)
      : await attachResultNode(db, source, fields);
  // Terminal path: the delivery settled this run done — write its
  // history row. The cross-kind branch already recorded it inside
  // attachResultNode; the shared (nodeId, startedAt) idempotency key
  // makes this second call a no-op there, while the in-place branch
  // (fillResultIntoNode) is covered only here.
  if (source.genStatus === "queued" || source.genStatus === "working") {
    await recordGenerationOutcome(db, source, {
      status: "done",
      resultNodeId: landedId,
      mediaBlobKey: fields.mediaBlobKey,
      mimeType: fields.mimeType,
      filePath: fields.filePath,
      genSize: fields.genSize ?? null,
      prompt: fields.recordPrompt ?? fields.prompt,
    });
  }
  return landedId;
}

/** Every generated image / video / audio also enters the asset
 * library, filed under its media kind AND stamped with the project
 * the carrying node belongs to — assets are per-project, never
 * shared. Deduped on the media blob key: a re-delivery of the same
 * bytes refreshes the existing row instead of piling up copies.
 * Best-effort by contract — an asset failure must never fail the
 * generation it rode in on. */
export async function recordMediaAsset(
  db: Db,
  row: NodeRow,
  opts: { title: string; prompt: string },
): Promise<void> {
  if (row.type !== "image" && row.type !== "video" && row.type !== "audio") {
    return;
  }
  if (!row.mediaBlobKey) return;
  try {
    const existing = await db
      .select()
      .from(schema.assets)
      .where(eq(schema.assets.mediaBlobKey, row.mediaBlobKey));
    const found = existing[0];
    if (found) {
      await db
        .update(schema.assets)
        .set({
          title: opts.title,
          prompt: opts.prompt,
          mimeType: row.mimeType,
          filePath: row.filePath,
          posterBlobKey: row.posterBlobKey,
          sourceNodeId: row.id,
          projectId: row.projectId,
        })
        .where(eq(schema.assets.id, found.id));
      return;
    }
    await db.insert(schema.assets).values({
      id: crypto.randomUUID(),
      projectId: row.projectId,
      kind: row.type,
      title: opts.title,
      content: "",
      prompt: opts.prompt,
      color: null,
      tags: "[]",
      sourceNodeId: row.id,
      mediaBlobKey: row.mediaBlobKey,
      mimeType: row.mimeType,
      filePath: row.filePath,
      posterBlobKey: row.posterBlobKey,
    });
  } catch {
    // The library copy is a convenience; the node is the deliverable.
  }
}

export async function markFailed(db: Db, nodeId: string, message: string): Promise<void> {
// Terminal path: a run that was in flight settles failed — write
// its history row from the pre-update row (the update below clears
// genStartedAt, which is part of the record's idempotency key).
const node = await getNodeRow(db, nodeId);
if (node && (node.genStatus === "queued" || node.genStatus === "working")) {
await recordGenerationOutcome(db, node, { status: "failed", error: message });
}
await db
.update(schema.canvasNodes)
.set({
genStatus: "failed",
genError: message,
genTaskId: null,
genClaimToken: null,
genStartedAt: null,
status: "error",
updatedAt: new Date(),
})
.where(eq(schema.canvasNodes.id, nodeId));
}

export async function markWorking(
db: Db,
nodeId: string,
patch: Partial<NodeRow> = {},
): Promise<void> {
await db
.update(schema.canvasNodes)
.set({
...patch,
genStatus: "working",
genError: null,
genStartedAt: new Date(),
status: "loading",
updatedAt: new Date(),
})
.where(eq(schema.canvasNodes.id, nodeId));
}

// Whole-graph save reconciliation (saveGraph): which missing rows a
// board save may delete, and how a re-inserted media node recovers
// its server-owned pointers.
//
// The race this guards (yoyo-02 #38, 2026-11-15): a tool result
// lands server-side as a brand-new node row (attachResultNode) while
// some open page still holds a graph from before the landing. That
// page's next whole-graph save does not contain the new node, so a
// payload-authoritative delete removes the row; when a page that
// DOES hold the node saves later, the upsert re-inserts it from
// nodeInput — which by design carries no server-owned media columns
// — and the node's media pointers are gone for good even though the
// bytes and the asset-library record survive.
//
// Two cooperating rules close it, both decided here so saveGraph
// stays a thin applier:
//  1. Deletion is limited to nodes the saving page has ADOPTED from
//     the server (its knownNodeIds: the node ids of its last
//     getProject adoption/merge plus every id it has itself saved).
//     A node absent from both the payload and that set was born
//     server-side after the page's snapshot; this page cannot be
//     deleting it on purpose, so the row (and any edge touching it)
//     is preserved untouched.
//  2. When a save (re-)inserts a node id that has no row — the
//     delete/undo half of the same race — the server-owned media
//     columns are restored from the asset-library record that
//     recordMediaAsset filed for exactly this node (sourceNodeId),
//     so the re-insert is lossless instead of pointer-free.

/** Node ids a whole-graph save may delete: rows missing from the
 * payload that the saving page had adopted from the server. When
 * knownIds is undefined (a caller that predates the field) the
 * payload stays authoritative, exactly as saves behaved before. */
export function planNodeDeletions(
  existingIds: readonly string[],
  payloadIds: ReadonlySet<string>,
  knownIds: ReadonlySet<string> | undefined,
): string[] {
  return existingIds.filter((id) => {
    if (payloadIds.has(id)) return false;
    if (knownIds === undefined) return true;
    return knownIds.has(id);
  });
}

/** Edge ids a whole-graph save may delete: edges missing from the
 * payload whose BOTH endpoints the saving page accounts for (in its
 * payload or its adopted set). An edge touching a server-born node
 * the page never adopted belongs to that node's landing, not to
 * this page, and is preserved with it. Legacy callers (knownIds
 * undefined) keep the payload-authoritative behavior. */
export function planEdgeDeletions(
  existingEdges: readonly { id: string; fromNodeId: string; toNodeId: string }[],
  payloadEdgeIds: ReadonlySet<string>,
  payloadIds: ReadonlySet<string>,
  knownIds: ReadonlySet<string> | undefined,
): string[] {
  const accounted = (id: string) =>
    payloadIds.has(id) || knownIds === undefined || knownIds.has(id);
  return existingEdges
    .filter(
      (e) =>
        !payloadEdgeIds.has(e.id) &&
        accounted(e.fromNodeId) &&
        accounted(e.toNodeId),
    )
    .map((e) => e.id);
}

export type ServerMediaRestore = {
  mediaBlobKey: string;
  mimeType: string | null;
  filePath: string | null;
  posterBlobKey: string | null;
  genSize: string | null;
};

/** The server-owned media payload of a node that exists only as an
 * asset-library record: recordMediaAsset files every landed media
 * node under sourceNodeId = the node's id, in the node's own
 * project, deduped on the blob key — that record is the second
 * source of truth a re-inserted node recovers its pointers from.
 * genSize is re-measured from the landed file (never copied from a
 * request); a failed probe leaves it null rather than guessing.
 * Returns null when no media asset record exists for the node. */
export async function findServerMediaRestore(
  ctx: Ctx,
  db: Db,
  projectId: string,
  nodeId: string,
): Promise<ServerMediaRestore | null> {
  const rows = await db
    .select()
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.sourceNodeId, nodeId),
        eq(schema.assets.projectId, projectId),
      ),
    );
  const asset = rows.find((a) => a.mediaBlobKey !== null);
  if (!asset || !asset.mediaBlobKey) return null;
  let genSize: string | null = null;
  if (asset.filePath && asset.kind !== "audio") {
    try {
      const probe = await ctx.executePrivileged(Contracts.probeMediaFile, {
        path: asset.filePath,
      });
      if (probe.width && probe.height) {
        genSize = `${probe.width}x${probe.height}`;
      }
    } catch {
      // Measurement is best-effort; the pointers are the repair.
    }
  }
  return {
    mediaBlobKey: asset.mediaBlobKey,
    mimeType: asset.mimeType,
    filePath: asset.filePath,
    posterBlobKey: asset.posterBlobKey,
    genSize,
  };
}

/** Repairs one media node whose server-owned pointers were lost
 * (mediaBlobKey null) by restoring them from its asset-library
 * record. The update is guarded on the pointer still being empty,
 * so a node that legitimately gained media in the meantime is never
 * overwritten. An image node's ratio label is re-derived from the
 * re-measured size through the ratios fact source, the same rule
 * the insert path uses. Returns true when this call repaired the
 * node. */
export async function repairNodeMediaPointers(
  ctx: Ctx,
  db: Db,
  row: NodeRow,
): Promise<boolean> {
  if (row.mediaBlobKey) return false;
  if (row.type !== "image" && row.type !== "video" && row.type !== "audio") {
    return false;
  }
  const restore = await findServerMediaRestore(ctx, db, row.projectId, row.id);
  if (!restore) return false;
  const updated = await db
    .update(schema.canvasNodes)
    .set({
      mediaBlobKey: restore.mediaBlobKey,
      mimeType: restore.mimeType,
      filePath: restore.filePath,
      posterBlobKey: restore.posterBlobKey,
      genSize: restore.genSize ?? row.genSize,
      genKind: row.genKind ?? row.type,
      ...(row.type === "image" && restore.genSize
        ? { genRatio: normalizeImageRatio(restore.genSize.replace("x", ":")) }
        : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.canvasNodes.id, row.id),
        isNull(schema.canvasNodes.mediaBlobKey),
      ),
    )
    .returning({ id: schema.canvasNodes.id });
  return updated.length > 0;
}
