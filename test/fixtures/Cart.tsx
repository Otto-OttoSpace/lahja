export function Cart() {
  return (
    <div>
      <h1>Your cart</h1>
      <input placeholder="Search products" />
      <button title="Remove item">Remove</button>
      <span>Subtotal: $99.00</span>
      <time>{new Date().toLocaleDateString()}</time>
      <p>مرحبا بك</p>
    </div>
  );
}
