/* static/js/tree.js */

import { TREE_CFG } from "./treeConfig.js";
import { renderFamilyTree, fitTreeToScreen } from "./familyTree.js";

function cfgNum(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function $(sel) {
  return document.querySelector(sel);
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

function byId(list) {
  const m = new Map();
  for (const it of list) m.set(it.id, it);
  return m;
}

function safeText(v) {
  return (v == null ? "" : String(v));
}

function makePersonNode(p) {
  return {
    id: p.id,
    kind: "person",
    label: safeText(p.name || p.label || p.id),
    gender: p.gender || null,
    birthYear: p.birthYear || p.birth_year || null,
    deathYear: p.deathYear || p.death_year || null,
    photoUrl: p.photoUrl || p.photo_url || p.photo || null,
  };
}

function unionKey(a, b) {
  const x = a || "_";
  const y = b || "_";
  return x < y ? `u:${x}:${y}` : `u:${y}:${x}`;
}

function buildGraph(treeJson, { previewMode, previewDepth }) {
  const people = Array.isArray(treeJson?.people) ? treeJson.people : [];
  const rels = Array.isArray(treeJson?.relationships) ? treeJson.relationships : [];

  const personNodes = [];
  const peopleById = new Map();

  for (const p of people) {
    const node = makePersonNode(p);
    personNodes.push(node);
    peopleById.set(node.id, node);
  }

  const unions = new Map();        // unionId -> { id, kind:"union", parents:[...], childIds:Set }
  const parentsByChild = new Map(); // childId -> Set(parentId)

  const ensurePerson = (id) => {
    if (!id) return null;
    const sid = String(id);
    if (!peopleById.has(sid)) {
      const node = {
        id: sid,
        kind: "person",
        label: sid,
        gender: null,
        birthYear: null,
        deathYear: null,
        photoUrl: null,
      };
      peopleById.set(sid, node);
      personNodes.push(node);
    }
    return sid;
  };

  const addParent = (childId, parentId) => {
    const c = ensurePerson(childId);
    const p = ensurePerson(parentId);
    if (!c || !p) return;
    if (!parentsByChild.has(c)) parentsByChild.set(c, new Set());
    parentsByChild.get(c).add(p);
  };

  // Support both schemas:
  //   { childId, parentId, otherParentId }
  //   { child, parent }
  for (const r of rels) {
    if (!r) continue;

    if (r.childId && r.parentId) {
      addParent(r.childId, r.parentId);
      if (r.otherParentId) addParent(r.childId, r.otherParentId);
      continue;
    }

    if (r.child && r.parent) {
      addParent(r.child, r.parent);
    }
  }

  // Build unions from child->parents
  for (const [childId, pset] of parentsByChild.entries()) {
    const ps = Array.from(pset).filter(Boolean).slice(0, 2);
    const p1 = ps[0] || null;
    const p2 = ps[1] || null;
    const uId = unionKey(p1, p2);

    if (!unions.has(uId)) {
      unions.set(uId, {
        id: uId,
        kind: "union",
        parents: uniq([p1, p2].filter(Boolean)),
        childIds: new Set(),
      });
    }

    unions.get(uId).childIds.add(childId);
  }

  // Force spouse unions to exist even if no children
  for (const r of rels) {
    if (!r || r.type !== "spouse" || !r.a || !r.b) continue;

    const a = ensurePerson(r.a);
    const b = ensurePerson(r.b);
    const uId = unionKey(a, b);

    if (!unions.has(uId)) {
      unions.set(uId, {
        id: uId,
        kind: "union",
        parents: uniq([a, b]),
        childIds: new Set(),
      });
    }
  }

  let nodes = [
    ...personNodes,
    ...Array.from(unions.values()).map((u) => ({
      id: u.id,
      kind: "union",
      parents: u.parents,
    })),
  ];

  let links = [];
  for (const u of unions.values()) {
    for (const pId of u.parents) {
      links.push({ sourceId: pId, targetId: u.id });
    }
    for (const cId of u.childIds) {
      links.push({ sourceId: u.id, targetId: cId });
    }
  }

  // Preview mode: keep descendants, but ALSO keep co-parents/spouses of visible unions
  if (previewMode && previewDepth > 0) {
    const childIds = new Set();
    for (const [c] of parentsByChild.entries()) childIds.add(c);

    const roots = personNodes.map((p) => p.id).filter((id) => !childIds.has(id));
    const start = roots.length ? [roots[0]] : (personNodes[0] ? [personNodes[0].id] : []);
    const keepPeople = new Set(start);
    const q = start.map((id) => ({ id, depth: 0 }));

    const parentToChildren = new Map();
    for (const [c, pset] of parentsByChild.entries()) {
      for (const p of pset) {
        if (!parentToChildren.has(p)) parentToChildren.set(p, []);
        parentToChildren.get(p).push(c);
      }
    }

    while (q.length) {
      const cur = q.shift();
      if (cur.depth >= previewDepth) continue;

      const kids = parentToChildren.get(cur.id) || [];
      for (const k of kids) {
        if (!keepPeople.has(k)) {
          keepPeople.add(k);
          q.push({ id: k, depth: cur.depth + 1 });
        }
      }
    }

    const keepUnions = new Set();

    for (const u of unions.values()) {
      const childKept = Array.from(u.childIds).some((c) => keepPeople.has(c));
      const parentKept = u.parents.some((p) => keepPeople.has(p));

      if (childKept || parentKept) {
        keepUnions.add(u.id);
        for (const p of u.parents) keepPeople.add(p); // keep co-parents/spouses
        for (const c of u.childIds) {
          if (childKept) keepPeople.add(c);
        }
      }
    }

    nodes = nodes.filter((n) => (n.kind === "person" ? keepPeople.has(n.id) : keepUnions.has(n.id)));
    const keepNodeIds = new Set(nodes.map((n) => n.id));
    links = links.filter((l) => keepNodeIds.has(l.sourceId) && keepNodeIds.has(l.targetId));
  }

  return { nodes, links };
}

function getPartnerMap(nodes, links) {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const parentsByUnion = new Map();
  const unionsByPerson = new Map();

  for (const lk of links) {
    const s = nodeMap.get(lk.sourceId);
    const t = nodeMap.get(lk.targetId);
    if (!s || !t) continue;

    if (s.kind === "person" && t.kind === "union") {
      if (!parentsByUnion.has(t.id)) parentsByUnion.set(t.id, []);
      parentsByUnion.get(t.id).push(s.id);

      if (!unionsByPerson.has(s.id)) unionsByPerson.set(s.id, []);
      unionsByPerson.get(s.id).push(t.id);
    }
  }

  const partnerMap = new Map(); // personId -> [{ unionId, partnerId }]
  for (const [unionId, parentIds] of parentsByUnion.entries()) {
    if (parentIds.length < 2) continue;

    for (let i = 0; i < parentIds.length; i++) {
      const selfId = parentIds[i];
      const others = parentIds.filter((id) => id !== selfId);

      if (!partnerMap.has(selfId)) partnerMap.set(selfId, []);
      for (const partnerId of others) {
        partnerMap.get(selfId).push({ unionId, partnerId });
      }
    }
  }

  return { partnerMap, parentsByUnion, unionsByPerson };
}

function layoutWithDagre(nodes, links) {
  const dagreLib = window.dagre;
  if (!dagreLib) throw new Error("dagre is missing (window.dagre not found)");

  const g = new dagreLib.graphlib.Graph();

  const cardW = cfgNum(TREE_CFG.sizing?.CARD_W, 86);
  const cardH = cfgNum(TREE_CFG.sizing?.CARD_H, 110);

  const rankdir = TREE_CFG.dagre?.rankdir || "TB";
  const nodesep = cfgNum(TREE_CFG.dagre?.nodesep, Math.round(cardW * 1.05));
  const ranksep = cfgNum(TREE_CFG.dagre?.ranksep, Math.round(cardH * 0.9));
  const marginx = cfgNum(TREE_CFG.dagre?.marginx, 20);
  const marginy = cfgNum(TREE_CFG.dagre?.marginy, 20);

  g.setGraph({
    rankdir,
    nodesep,
    ranksep,
    marginx,
    marginy,
  });

  g.setDefaultEdgeLabel(() => ({}));

  for (const n of nodes) {
    if (n.kind === "union") {
      g.setNode(n.id, {
        width: 10,
        height: 10,
      });
    } else {
      g.setNode(n.id, {
        width: cardW,
        height: cardH,
      });
    }
  }

  for (const lk of links) {
    if (!lk?.sourceId || !lk?.targetId) continue;
    if (!g.hasNode(lk.sourceId) || !g.hasNode(lk.targetId)) continue;
    g.setEdge(lk.sourceId, lk.targetId);
  }

  dagreLib.layout(g);

  const byNodeId = new Map(nodes.map((n) => [n.id, n]));

  for (const id of g.nodes()) {
    const pos = g.node(id);
    const n = byNodeId.get(id);
    if (!n || !pos) continue;

    if (n.kind === "union") {
      n.x = pos.x;
      n.y = pos.y;
    } else {
      n.x = pos.x - cardW / 2;
      n.y = pos.y - cardH / 2;
    }
  }
}

function centerChildrenUnderParents(nodes, links) {
  const { CARD_W } = TREE_CFG.sizing;

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  const outgoing = new Map();
  for (const lk of links) {
    if (!lk?.sourceId || !lk?.targetId) continue;
    if (!outgoing.has(lk.sourceId)) outgoing.set(lk.sourceId, []);
    outgoing.get(lk.sourceId).push(lk.targetId);
  }

  const unionChildren = new Map();
  for (const lk of links) {
    const src = nodeMap.get(lk.sourceId);
    if (src?.kind === "union") {
      if (!unionChildren.has(lk.sourceId)) unionChildren.set(lk.sourceId, []);
      unionChildren.get(lk.sourceId).push(lk.targetId);
    }
  }

  const unions = nodes
    .filter((n) => n.kind === "union" && Number.isFinite(n.x) && Number.isFinite(n.y))
    .sort((a, b) => (a.y - b.y) || (a.x - b.x));

  function shiftSubtree(rootId, dx, visited = new Set()) {
    const stack = [rootId];

    while (stack.length) {
      const id = stack.pop();
      if (visited.has(id)) continue;
      visited.add(id);

      const n = nodeMap.get(id);
      if (n) n.x += dx;

      const kids = outgoing.get(id) || [];
      for (const childId of kids) stack.push(childId);
    }
  }

  for (const u of unions) {
    const childIds = unionChildren.get(u.id) || [];
    if (!childIds.length) continue;

    const childCenters = [];

    for (const childId of childIds) {
      const child = nodeMap.get(childId);
      if (!child || !Number.isFinite(child.x)) continue;

      const cx = child.kind === "union" ? child.x : child.x + CARD_W / 2;
      childCenters.push(cx);
    }

    if (!childCenters.length) continue;

    const minX = Math.min(...childCenters);
    const maxX = Math.max(...childCenters);
    const desiredCenter = (minX + maxX) / 2;
    const dx = u.x - desiredCenter;

    if (Math.abs(dx) < 0.5) continue;

    const visited = new Set();
    for (const childId of childIds) {
      shiftSubtree(childId, dx, visited);
    }
  }
}


function spreadMultiPartnerFamilies(nodes, links) {
  const { CARD_W } = TREE_CFG.sizing;
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  const minPartnerGap = cfgNum(
    TREE_CFG.layout?.minPartnerGap,
    cfgNum(TREE_CFG.layout?.spouseGap, CARD_W + 36)
  );

  const outgoing = new Map();
  const unionsByPerson = new Map();
  const parentsByUnion = new Map();

  for (const lk of links) {
    if (!lk?.sourceId || !lk?.targetId) continue;

    if (!outgoing.has(lk.sourceId)) outgoing.set(lk.sourceId, []);
    outgoing.get(lk.sourceId).push(lk.targetId);

    const s = nodeMap.get(lk.sourceId);
    const t = nodeMap.get(lk.targetId);
    if (!s || !t) continue;

    if (s.kind === "person" && t.kind === "union") {
      if (!unionsByPerson.has(s.id)) unionsByPerson.set(s.id, []);
      unionsByPerson.get(s.id).push(t.id);

      if (!parentsByUnion.has(t.id)) parentsByUnion.set(t.id, []);
      parentsByUnion.get(t.id).push(s.id);
    }
  }

  function shiftSubtree(rootId, dx, visited = new Set()) {
    const stack = [rootId];

    while (stack.length) {
      const id = stack.pop();
      if (visited.has(id)) continue;
      visited.add(id);

      const n = nodeMap.get(id);
      if (n) n.x += dx;

      const kids = outgoing.get(id) || [];
      for (const childId of kids) {
        stack.push(childId);
      }
    }
  }

  function shiftPartnerFamily(partnerId, unionId, dx) {
    const visited = new Set();

    const partner = nodeMap.get(partnerId);
    if (partner && !visited.has(partnerId)) {
      partner.x += dx;
      visited.add(partnerId);
    }

    const unionNode = nodeMap.get(unionId);
    if (unionNode && !visited.has(unionId)) {
      unionNode.x += dx;
      visited.add(unionId);
    }

    const kids = outgoing.get(unionId) || [];
    for (const childId of kids) {
      shiftSubtree(childId, dx, visited);
    }
  }

  function recenterUnion(unionId) {
    const parentIds = parentsByUnion.get(unionId) || [];
    if (parentIds.length < 2) return;

    const parents = parentIds
      .map((id) => nodeMap.get(id))
      .filter(Boolean)
      .sort((a, b) => a.x - b.x);

    if (parents.length < 2) return;

    const left = parents[0];
    const right = parents[parents.length - 1];
    const unionNode = nodeMap.get(unionId);
    if (!unionNode) return;

    const leftInner = left.x + CARD_W;
    const rightInner = right.x;
    unionNode.x = (leftInner + rightInner) / 2;
  }

  for (const [personId, unionIds] of unionsByPerson.entries()) {
    const anchor = nodeMap.get(personId);
    if (!anchor || unionIds.length < 2 || !Number.isFinite(anchor.x)) continue;

    const partnerEntries = [];
    const seen = new Set();

    for (const unionId of unionIds) {
      const parentIds = parentsByUnion.get(unionId) || [];
      const partnerId = parentIds.find((id) => id !== personId);
      if (!partnerId) continue;

      const dedupeKey = `${unionId}|${partnerId}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const partner = nodeMap.get(partnerId);
      if (!partner) continue;

      partnerEntries.push({
        unionId,
        partnerId,
        partner,
      });
    }

    if (partnerEntries.length < 2) continue;

    // Sort by current x to keep layout stable
    partnerEntries.sort((a, b) => a.partner.x - b.partner.x);

    const anchorX = anchor.x;

    if (partnerEntries.length === 2) {
      // Hard rule: one left, one right
      const leftItem = partnerEntries[0];
      const rightItem = partnerEntries[1];

      const leftDesiredX = anchorX - minPartnerGap;
      const rightDesiredX = anchorX + minPartnerGap;

      const leftDx = leftDesiredX - leftItem.partner.x;
      const rightDx = rightDesiredX - rightItem.partner.x;

      if (Math.abs(leftDx) > 0.5) {
        shiftPartnerFamily(leftItem.partnerId, leftItem.unionId, leftDx);
      }
      if (Math.abs(rightDx) > 0.5) {
        shiftPartnerFamily(rightItem.partnerId, rightItem.unionId, rightDx);
      }

      recenterUnion(leftItem.unionId);
      recenterUnion(rightItem.unionId);
      continue;
    }

    // 3+ partners: alternate around anchor
    const leftSide = [];
    const rightSide = [];

    partnerEntries.forEach((item, idx) => {
      if (idx % 2 === 0) leftSide.push(item);
      else rightSide.push(item);
    });

    leftSide.reverse();

    for (let i = 0; i < leftSide.length; i++) {
      const item = leftSide[i];
      const desiredX = anchorX - ((i + 1) * minPartnerGap);
      const dx = desiredX - item.partner.x;
      if (Math.abs(dx) > 0.5) {
        shiftPartnerFamily(item.partnerId, item.unionId, dx);
      }
      recenterUnion(item.unionId);
    }

    for (let i = 0; i < rightSide.length; i++) {
      const item = rightSide[i];
      const desiredX = anchorX + ((i + 1) * minPartnerGap);
      const dx = desiredX - item.partner.x;
      if (Math.abs(dx) > 0.5) {
        shiftPartnerFamily(item.partnerId, item.unionId, dx);
      }
      recenterUnion(item.unionId);
    }

    for (const item of partnerEntries) {
      recenterUnion(item.unionId);
    }
  }
}



function resolveHorizontalOverlaps(nodes, links) {
  const { CARD_W, CARD_H } = TREE_CFG.sizing;

  const minGap = cfgNum(TREE_CFG.layout?.minNodeGap, 20);
  const siblingGap = cfgNum(TREE_CFG.layout?.siblingGap, minGap);
  const rowTolerance = cfgNum(
    TREE_CFG.layout?.rowTolerance,
    Math.max(18, Math.round(CARD_H * 0.35))
  );

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  const outgoing = new Map();
  for (const lk of links) {
    if (!lk?.sourceId || !lk?.targetId) continue;
    if (!outgoing.has(lk.sourceId)) outgoing.set(lk.sourceId, []);
    outgoing.get(lk.sourceId).push(lk.targetId);
  }

  const unionsByPerson = new Map();
  const parentsByUnion = new Map();
  const childrenByUnion = new Map();

  for (const lk of links) {
    const s = nodeMap.get(lk.sourceId);
    const t = nodeMap.get(lk.targetId);
    if (!s || !t) continue;

    if (s.kind === "person" && t.kind === "union") {
      if (!unionsByPerson.has(s.id)) unionsByPerson.set(s.id, []);
      unionsByPerson.get(s.id).push(t.id);

      if (!parentsByUnion.has(t.id)) parentsByUnion.set(t.id, []);
      parentsByUnion.get(t.id).push(s.id);
    }

    if (s.kind === "union" && t.kind === "person") {
      if (!childrenByUnion.has(s.id)) childrenByUnion.set(s.id, []);
      childrenByUnion.get(s.id).push(t.id);
    }
  }

  function shiftSubtree(rootId, dx, visited = new Set()) {
    const stack = [rootId];

    while (stack.length) {
      const id = stack.pop();
      if (visited.has(id)) continue;
      visited.add(id);

      const n = nodeMap.get(id);
      if (n) n.x += dx;

      const kids = outgoing.get(id) || [];
      for (const childId of kids) {
        stack.push(childId);
      }
    }
  }

  function shiftCoupleBlock(personId, dx, visited = new Set()) {
    const p = nodeMap.get(personId);
    if (p && !visited.has(personId)) {
      p.x += dx;
      visited.add(personId);
    }

    const unionIds = unionsByPerson.get(personId) || [];
    for (const uId of unionIds) {
      const u = nodeMap.get(uId);
      if (u && !visited.has(uId)) {
        u.x += dx;
        visited.add(uId);
      }

      const parentIds = parentsByUnion.get(uId) || [];
      for (const otherParentId of parentIds) {
        if (visited.has(otherParentId)) continue;
        const other = nodeMap.get(otherParentId);
        if (other) {
          other.x += dx;
          visited.add(otherParentId);
        }
      }

      const childIds = childrenByUnion.get(uId) || [];
      for (const childId of childIds) {
        shiftSubtree(childId, dx, visited);
      }
    }
  }

  function buildRows() {
    const people = nodes
      .filter((n) => n.kind === "person" && Number.isFinite(n.x) && Number.isFinite(n.y))
      .sort((a, b) => (a.y - b.y) || (a.x - b.x));

    const rows = [];
    for (const n of people) {
      const last = rows[rows.length - 1];
      if (!last || Math.abs(last.y - n.y) > rowTolerance) {
        rows.push({ y: n.y, nodes: [n] });
      } else {
        last.nodes.push(n);
      }
    }

    for (const row of rows) {
      row.nodes.sort((a, b) => a.x - b.x);
    }

    return rows;
  }

  // PASS 1: normal left-to-right card collision cleanup
  for (let pass = 0; pass < 4; pass++) {
    const rows = buildRows();
    let moved = false;

    for (const row of rows) {
      for (let i = 1; i < row.nodes.length; i++) {
        const left = row.nodes[i - 1];
        const right = row.nodes[i];

        const requiredX = left.x + CARD_W + siblingGap;
        if (right.x < requiredX) {
          const dx = requiredX - right.x;
          shiftCoupleBlock(right.id, dx);
          moved = true;
        }
      }
    }

    if (!moved) break;
  }

  // PASS 2: keep children out from directly between co-parents
  const unions = nodes.filter((n) => n.kind === "union" && Number.isFinite(n.x) && Number.isFinite(n.y));

  for (const u of unions) {
    const parentIds = parentsByUnion.get(u.id) || [];
    if (parentIds.length < 2) continue;

    const parents = parentIds
      .map((id) => nodeMap.get(id))
      .filter(Boolean)
      .sort((a, b) => a.x - b.x);

    if (parents.length < 2) continue;

    const leftParent = parents[0];
    const rightParent = parents[parents.length - 1];

    const laneLeft = leftParent.x + CARD_W;
    const laneRight = rightParent.x;

    if (laneRight <= laneLeft) {
      const dx = (laneLeft + minGap) - laneRight;
      if (dx > 0) shiftCoupleBlock(rightParent.id, dx);
      continue;
    }

    const unionKids = new Set(childrenByUnion.get(u.id) || []);
    const trunkHalfWidth = cfgNum(TREE_CFG.layout?.trunkLaneRatio, 0.18) * CARD_W;
    const trunkLeft = u.x - trunkHalfWidth;
    const trunkRight = u.x + trunkHalfWidth;

    for (const n of nodes) {
      if (n.kind !== "person") continue;
      if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
      if (n.y <= leftParent.y + rowTolerance) continue;

      const centerX = n.x + CARD_W / 2;
      const overlapsParentLane = centerX > laneLeft && centerX < laneRight;
      if (!overlapsParentLane) continue;

      if (unionKids.has(n.id)) {
        const nLeft = n.x;
        const nRight = n.x + CARD_W;
        const overlapsTrunk = !(nRight < trunkLeft || nLeft > trunkRight);
        if (overlapsTrunk) {
          const dx = (trunkRight + minGap) - nLeft;
          if (dx > 0) shiftSubtree(n.id, dx);
        }
        continue;
      }

      const dx = (laneRight + minGap) - n.x;
      if (dx > 0) shiftCoupleBlock(n.id, dx);
    }
  }

  // PASS 3: final cleanup in case earlier pushes created new collisions
  for (let pass = 0; pass < 4; pass++) {
    const rows = buildRows();
    let moved = false;

    for (const row of rows) {
      for (let i = 1; i < row.nodes.length; i++) {
        const left = row.nodes[i - 1];
        const right = row.nodes[i];

        const requiredX = left.x + CARD_W + siblingGap;
        if (right.x < requiredX) {
          const dx = requiredX - right.x;
          shiftCoupleBlock(right.id, dx);
          moved = true;
        }
      }
    }

    if (!moved) break;
  }
}

function applyStructuredFamilyLayout(nodes, links) {
  const CARD_W = cfgNum(TREE_CFG.sizing?.CARD_W, 86);
  const spouseGap = cfgNum(TREE_CFG.layout?.spouseGap, 28);
  const siblingGap = cfgNum(TREE_CFG.layout?.siblingGap, 26);
  const clusterGap = cfgNum(TREE_CFG.layout?.clusterGap, 34);
  const rowTolerance = cfgNum(TREE_CFG.layout?.rowTolerance, 22);

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const parentsByUnion = new Map();
  const childrenByUnion = new Map();
  const parentUnionByPerson = new Map();
  const spouseUnionsByPerson = new Map();

  for (const lk of links) {
    const s = nodeMap.get(lk.sourceId);
    const t = nodeMap.get(lk.targetId);
    if (!s || !t) continue;

    if (s.kind === "person" && t.kind === "union") {
      if (!parentsByUnion.has(t.id)) parentsByUnion.set(t.id, []);
      parentsByUnion.get(t.id).push(s.id);
      if (!spouseUnionsByPerson.has(s.id)) spouseUnionsByPerson.set(s.id, []);
      spouseUnionsByPerson.get(s.id).push(t.id);
    }

    if (s.kind === "union" && t.kind === "person") {
      if (!childrenByUnion.has(s.id)) childrenByUnion.set(s.id, []);
      childrenByUnion.get(s.id).push(t.id);
      if (!parentUnionByPerson.has(t.id)) parentUnionByPerson.set(t.id, []);
      parentUnionByPerson.get(t.id).push(s.id);
    }
  }

  const people = nodes
    .filter((n) => n.kind === "person" && Number.isFinite(n.x) && Number.isFinite(n.y))
    .sort((a, b) => (a.y - b.y) || (a.x - b.x));

  const rows = [];
  for (const person of people) {
    const last = rows[rows.length - 1];
    if (!last || Math.abs(last.y - person.y) > rowTolerance) {
      rows.push({ y: person.y, people: [person] });
    } else {
      last.people.push(person);
    }
  }

  const rowIndexByPerson = new Map();
  rows.forEach((row, idx) => row.people.forEach((p) => rowIndexByPerson.set(p.id, idx)));

  function buildBlocks(row) {
    const rowSet = new Set(row.people.map((p) => p.id));
    const adj = new Map(row.people.map((p) => [p.id, new Set()]));

    for (const [unionId, parentIds] of parentsByUnion.entries()) {
      const onRow = parentIds.filter((id) => rowSet.has(id));
      if (onRow.length < 2) continue;
      const ordered = onRow.slice().sort((a, b) => nodeMap.get(a).x - nodeMap.get(b).x);
      for (let i = 1; i < ordered.length; i++) {
        adj.get(ordered[i - 1]).add(ordered[i]);
        adj.get(ordered[i]).add(ordered[i - 1]);
      }
    }

    function orderBlockMembers(ids) {
      const uniqueIds = [...new Set(ids)];
      if (uniqueIds.length <= 2) {
        return uniqueIds
          .map((id) => nodeMap.get(id))
          .filter(Boolean)
          .sort((a, b) => a.x - b.x);
      }

      const degreeOne = uniqueIds.filter((id) => (adj.get(id)?.size || 0) === 1);
      const startId = degreeOne.length
        ? degreeOne.slice().sort((a, b) => nodeMap.get(a).x - nodeMap.get(b).x)[0]
        : uniqueIds.slice().sort((a, b) => nodeMap.get(a).x - nodeMap.get(b).x)[0];

      const ordered = [];
      const walked = new Set();
      let cur = startId;
      let prev = null;

      while (cur && !walked.has(cur)) {
        walked.add(cur);
        ordered.push(nodeMap.get(cur));

        const neighbors = [...(adj.get(cur) || [])]
          .filter((id) => id !== prev)
          .sort((a, b) => nodeMap.get(a).x - nodeMap.get(b).x);

        const next = neighbors.find((id) => !walked.has(id));
        prev = cur;
        cur = next || null;
      }

      for (const id of uniqueIds) {
        if (!walked.has(id)) ordered.push(nodeMap.get(id));
      }

      return ordered.filter(Boolean);
    }

    const visited = new Set();
    const blocks = [];
    for (const person of row.people) {
      if (visited.has(person.id)) continue;
      const stack = [person.id];
      const ids = [];
      visited.add(person.id);
      while (stack.length) {
        const id = stack.pop();
        ids.push(id);
        for (const next of adj.get(id) || []) {
          if (visited.has(next)) continue;
          visited.add(next);
          stack.push(next);
        }
      }
      const members = orderBlockMembers(ids);
      blocks.push({
        ids: members.map((m) => m.id),
        members,
        width: members.length * CARD_W + Math.max(0, members.length - 1) * spouseGap,
        currentCenter: members.reduce((sum, m) => sum + (m.x + CARD_W / 2), 0) / members.length,
      });
    }
    blocks.sort((a, b) => a.currentCenter - b.currentCenter);
    return blocks;
  }

  function assignBlockCoords(block, leftX) {
    let cursor = leftX;
    for (const member of block.members) {
      member.x = cursor;
      cursor += CARD_W + spouseGap;
    }
    block.left = leftX;
    block.right = cursor - spouseGap;
    block.center = (block.left + block.right) / 2;
  }

  function recenterUnionsForRow(row) {
    const rowSet = new Set(row.people.map((p) => p.id));
    for (const [unionId, parentIds] of parentsByUnion.entries()) {
      const onRow = parentIds
        .filter((id) => rowSet.has(id))
        .map((id) => nodeMap.get(id))
        .filter(Boolean)
        .sort((a, b) => a.x - b.x);
      if (onRow.length < 2) continue;
      const left = onRow[0].x + CARD_W;
      const right = onRow[onRow.length - 1].x;
      const unionNode = nodeMap.get(unionId);
      if (unionNode) unionNode.x = (left + right) / 2;
    }
  }

  function primaryParentUnion(personId) {
    const unions = (parentUnionByPerson.get(personId) || []).filter((id) => nodeMap.has(id));
    if (!unions.length) return null;
    if (unions.length === 1) return unions[0];
    unions.sort((a, b) => (nodeMap.get(a).x - nodeMap.get(b).x));
    return unions[0];
  }

  function layoutRow(rowIndex) {
    const row = rows[rowIndex];
    const blocks = buildBlocks(row);
    const blockByPerson = new Map();
    blocks.forEach((block, idx) => block.ids.forEach((id) => blockByPerson.set(id, idx)));

    const clusters = [];
    const seenBlocks = new Set();
    for (const block of blocks) {
      const blockId = blocks.indexOf(block);
      if (seenBlocks.has(blockId)) continue;
      const memberParentUnions = block.ids.map(primaryParentUnion).filter(Boolean);
      const parentUnionId = memberParentUnions.length ? memberParentUnions[0] : null;
      const clusterBlocks = [];
      if (parentUnionId) {
        const childIds = (childrenByUnion.get(parentUnionId) || []).filter((id) => blockByPerson.has(id));
        const orderedBlockIds = [...new Set(childIds.map((id) => blockByPerson.get(id)))].sort((a, b) => blocks[a].currentCenter - blocks[b].currentCenter);
        for (const idx of orderedBlockIds) {
          if (seenBlocks.has(idx)) continue;
          seenBlocks.add(idx);
          clusterBlocks.push(blocks[idx]);
        }
      } else {
        seenBlocks.add(blockId);
        clusterBlocks.push(block);
      }

      const center = parentUnionId && nodeMap.get(parentUnionId)
        ? nodeMap.get(parentUnionId).x
        : clusterBlocks.reduce((sum, b) => sum + b.currentCenter, 0) / clusterBlocks.length;

      const clusterWidth = clusterBlocks.reduce((sum, b) => sum + b.width, 0) + Math.max(0, clusterBlocks.length - 1) * siblingGap;
      clusters.push({ parentUnionId, blocks: clusterBlocks, desiredCenter: center, width: clusterWidth });
    }

    clusters.sort((a, b) => a.desiredCenter - b.desiredCenter);

    let lastRight = null;
    for (const cluster of clusters) {
      let left = cluster.desiredCenter - cluster.width / 2;
      if (lastRight != null) left = Math.max(left, lastRight + clusterGap);

      let cursor = left;
      for (const block of cluster.blocks) {
        assignBlockCoords(block, cursor);
        cursor += block.width + siblingGap;
      }
      cluster.left = left;
      cluster.right = cursor - siblingGap;
      lastRight = cluster.right;
    }

    // second pass to tighten any accidental block collisions inside same row
    const allBlocks = clusters.flatMap((cluster) => cluster.blocks.map((block) => ({ cluster, block })))
      .sort((a, b) => a.block.left - b.block.left);
    for (let i = 1; i < allBlocks.length; i++) {
      const leftItem = allBlocks[i - 1];
      const rightItem = allBlocks[i];
      const gap = leftItem.cluster === rightItem.cluster ? siblingGap : clusterGap;
      const needed = leftItem.block.right + gap;
      if (rightItem.block.left < needed) {
        assignBlockCoords(rightItem.block, needed);
        rightItem.block.left = needed;
        rightItem.block.right = needed + rightItem.block.width;
      }
    }

    recenterUnionsForRow(row);
  }

  for (let i = 0; i < rows.length; i++) {
    layoutRow(i);
  }

  // final child centering pass: move sibling clusters together while preserving row packing
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const rowPeople = row.people.slice().sort((a, b) => a.x - b.x);
    const personIds = new Set(rowPeople.map((p) => p.id));
    const groups = [];
    for (const [unionId, childIds] of childrenByUnion.entries()) {
      const kids = childIds.filter((id) => personIds.has(id)).map((id) => nodeMap.get(id)).sort((a, b) => a.x - b.x);
      if (!kids.length) continue;
      groups.push({ unionId, kids });
    }
    groups.sort((a, b) => nodeMap.get(a.unionId).x - nodeMap.get(b.unionId).x);

    let prevRight = null;
    for (const group of groups) {
      const unionX = nodeMap.get(group.unionId).x;
      const leftMost = group.kids[0].x;
      const rightMost = group.kids[group.kids.length - 1].x + CARD_W;
      const width = rightMost - leftMost;
      let desiredLeft = unionX - width / 2;
      if (prevRight != null) desiredLeft = Math.max(desiredLeft, prevRight + clusterGap);
      const dx = desiredLeft - leftMost;
      if (Math.abs(dx) > 0.5) {
        for (const kid of group.kids) kid.x += dx;
      }
      prevRight = (group.kids[group.kids.length - 1].x + CARD_W);
    }
  }

  for (const row of rows) recenterUnionsForRow(row);
}


async function fetchTreeJson() {
  const url = window.TREE_API_URL;
  if (!url) throw new Error("TREE_API_URL is not set");

  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Tree API ${res.status} ${res.statusText}`);
  return res.json();
}

function parseBool(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(v)) return true;
    if (["false", "0", "no", "off", ""].includes(v)) return false;
  }
  if (typeof value === "number") return value !== 0;
  return fallback;
}

function wireToolbar(renderFull) {
  const btnFit = $("#fitTreeBtn") || $("#btnFit");
  if (btnFit) btnFit.addEventListener("click", () => fitTreeToScreen());

  const btnFull = $("#treeMoreBtn") || $("#btnFull");
  if (btnFull) btnFull.addEventListener("click", renderFull);
}

async function boot() {
  const svg = $("#treeSvg");
  if (!svg) return;

  let treeJson;
  try {
    treeJson = await fetchTreeJson();
  } catch (e) {
    console.error("[LineAgeMap] tree API failed", e);
    return;
  }

  const state = { treeJson, preview: parseBool(window.TREE_PREVIEW_MODE, false) };
  const previewDepth = Number(window.TREE_PREVIEW_DEPTH || 2);

  const render = () => {
    const { nodes, links } = buildGraph(state.treeJson, {
      previewMode: state.preview,
      previewDepth,
    });

    try {
      layoutWithDagre(nodes, links);
      applyStructuredFamilyLayout(nodes, links);
      renderFamilyTree(svg, { nodes, links });
      fitTreeToScreen();
    } catch (e) {
      console.error("[LineAgeMap] tree render failed", e);
    }
  };

  const renderFull = () => {
    state.preview = false;
    render();
  };

  wireToolbar(renderFull);
  render();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
