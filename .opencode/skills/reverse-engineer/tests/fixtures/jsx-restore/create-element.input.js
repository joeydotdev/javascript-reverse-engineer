import { createElement, Fragment } from 'react';

export function SimpleDiv() {
  return createElement('div', { className: 'wrapper' },
    createElement('h1', null, 'Title'),
    createElement('p', null, 'Some text content'),
  );
}
