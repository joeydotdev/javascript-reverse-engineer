import { jsx, jsxs } from 'react/jsx-runtime';
import { Modal } from './modal';
import { ModalBody } from './modal-body';
import { ModalTitle } from './modal-title';
import { Button } from './button';

export function ConfirmModal({ title, onConfirm }) {
  return jsx(Modal, {
    active: true,
    children: jsxs(ModalBody, {
      children: [
        jsx(ModalTitle, { children: title }),
        jsx(Button, { onClick: onConfirm, children: 'Confirm' }),
      ],
    }),
  });
}
