import { Button } from './ui';
const KEY = 'add_to_cart';
const variant = 'primary';
const href = '/checkout';
export function View() {
  return <Button className="btn-primary" data-testid="cta" type="submit" id="go" />;
}
