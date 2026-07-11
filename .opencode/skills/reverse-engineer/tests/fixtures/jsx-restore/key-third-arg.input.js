import { jsx } from 'react/jsx-runtime';

export function ItemList({ items }) {
  return items.map((item) =>
    jsx('li', { className: 'item', children: item.name }, item.id)
  );
}
