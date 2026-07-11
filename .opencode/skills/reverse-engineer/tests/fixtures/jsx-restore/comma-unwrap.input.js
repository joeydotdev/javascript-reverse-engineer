import { jsx as _jsx, jsxs as _jsxs } from 'react/jsx-runtime';
import { Spinner } from './spinner';
import { Alert } from './alert';

export function Status({ loading, message }) {
  return (0, _jsxs)('div', {
    className: 'status',
    children: [
      loading ? (0, _jsx)(Spinner, {}) : null,
      (0, _jsx)(Alert, { children: message }),
    ],
  });
}
