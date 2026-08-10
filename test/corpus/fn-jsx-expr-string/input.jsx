export const Panel = ({ cond, v }) => (
  <section>
    <p>{"مرحبا بالعالم هنا"}</p>
    <button>{"Save changes"}</button>
    <p>{cond ? "yes" : "no"}</p>
    <p>{v || "fallback"}</p>
    <code>{"npm install"}</code>
    <span>{"/"}</span>
  </section>
);
