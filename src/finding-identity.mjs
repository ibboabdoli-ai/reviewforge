/**
 * Identity for the same reported root cause at a changed-line anchor.
 * A location alone is not an identity: independent defects can share one line.
 * Keep category and normalized title so same-cause severity duplicates collapse.
 * This is a deterministic proxy, not semantic equivalence proof.
 */
export function findingIdentity(finding) {
  const normalize = value => String(value??'').trim().toLowerCase().replace(/\s+/g,' ');
  return JSON.stringify([
    finding.path, finding.line,
    normalize(finding.category||'correctness'), normalize(finding.title)
  ]);
}

/** Input already sorted by risk; preserve different causes at the same line. */
export function distinctFindings(sortedFindings,limit=8) {
  const seen=new Set(),selected=[];
  for(const item of sortedFindings) {
    const key=findingIdentity(item);
    if(seen.has(key))continue;
    seen.add(key);
    selected.push(item);
    if(selected.length>=limit)break;
  }
  return selected;
}
