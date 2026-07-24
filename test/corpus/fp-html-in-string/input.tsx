// Bug #3 guard: '<html>' inside a JS string is not a JSX element → no lang finding.
export const template = '<html><body>hello</body></html>';
export function render() {
  return document.write('<html lang could be anything here>');
}
