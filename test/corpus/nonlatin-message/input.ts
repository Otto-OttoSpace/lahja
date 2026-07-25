// Script-aware: single-token non-Latin UI text (no space, no Title-case) is
// still a real message — the old Latin-only gate missed all three of these.
export function ui() {
  const label = '保存';
  alert('บันทึกแล้ว');
  const cta = 'احفظ';
  return { label, cta };
}
