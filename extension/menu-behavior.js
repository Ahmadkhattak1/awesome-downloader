globalThis.awesomeMenuResult = (response, { accepted, rejected }) => {
  if (response?.ok) {
    accepted();
    return true;
  }
  rejected(response?.error || 'The desktop app did not accept this download.');
  return false;
};
