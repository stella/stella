// Styles for classes the sender's own markup carries (calendar invitations
// exported from Google mail), restored because sanitizing strips the sender's
// stylesheet. These colours are the sender's document content, not ours.
export const EMAIL_SENDER_CLASS_CSS = `
.primary-text {
  color: #3c4043;
}
.secondary-text, .grey-button-text {
  color: #70757a;
}
.accent-text {
  color: #1a73e8;
}
.primary-button {
  background: #1a73e8;
  border-radius: 4px;
  color: #fff;
}
.primary-button-text {
  color: #fff;
}`;
