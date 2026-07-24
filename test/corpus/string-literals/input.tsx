export function actions(id: string) {
  const label = 'Add to cart';
  alert('Saved');
  toast(`Order ${id} confirmed`);
  const meta = { title: 'Welcome back', className: 'btn-primary', id: 'checkout-1' };
  return { label, meta };
}
