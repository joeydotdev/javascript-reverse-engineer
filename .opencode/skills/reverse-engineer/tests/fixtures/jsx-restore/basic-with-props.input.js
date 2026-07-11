import { jsx } from 'react/jsx-runtime';
import { Button } from './button';

export function SubmitButton() {
  return jsx(Button, {
    disabled: true,
    size: 'large',
    onClick: () => console.log('clicked'),
    children: 'Submit',
  });
}
