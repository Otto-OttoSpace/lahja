// word-break:break-all breaks between ANY two chars — wrong for CJK/Thai lines.
export function Box() {
  return <div style={{ wordBreak: 'break-all' }} className="box" />;
}
