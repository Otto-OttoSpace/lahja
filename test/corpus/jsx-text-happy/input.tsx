export function Cart() {
  return (
    <div className="cart">
      <h1>Your cart</h1>
      <button aria-label="Close cart" placeholder='Search items'>Checkout</button>
      <span>{total}</span>
    </div>
  );
}
