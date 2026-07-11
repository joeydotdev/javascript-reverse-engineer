import { jsx, jsxs, Fragment } from 'react/jsx-runtime';

export function TwoButtons() {
  return jsxs(Fragment, {
    children: [
      jsx('button', { children: 'Cancel' }),
      jsx('button', { children: 'OK' }),
    ],
  });
}
