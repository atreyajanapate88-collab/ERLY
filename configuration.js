document.addEventListener('DOMContentLoaded', async () => {
  const form = document.querySelector('[data-server-configuration-form]');
  const message = document.querySelector('[data-configuration-message]');
  const saveButton = document.querySelector('[data-save-server-configuration]');

  const readApiResponse = async (response) => {
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data.message = text;
    }
    if (!response.ok) throw new Error(data.error || data.message || 'The server request failed.');
    return data;
  };

  try {
    const response = await fetch('/api/erlc/current');
    const { server } = await readApiResponse(response);
    if (!server) {
      window.location.assign('/dashboard.html');
      return;
    }
    form.elements.displayName.value = server.serverName || '';
    form.elements.welcomeMessage.value = server.welcomeMessage || '';
    document.querySelector('[data-config-erlc-name]').textContent = server.erlcServerName || server.serverName || 'Unavailable';
    document.querySelector('[data-config-discord-name]').textContent = server.discordGuildName || 'Unavailable';
    document.querySelector('[data-config-owner]').textContent = server.ownerRobloxUsername || 'Unavailable';
    document.querySelector('[data-config-join-code]').textContent = server.joinCode || 'Unavailable';
    document.querySelector('[data-config-api-key]').textContent = server.serverApiKeySaved
      ? 'Saved securely (hidden)'
      : 'Not saved';
    const deliveryStatus = document.querySelector('[data-config-delivery-status]');
    if (server.welcomeDeliveryStatus === 'error') {
      deliveryStatus.textContent = `ER:LC could not send the welcome message: ${server.welcomeDeliveryError || 'The command was rejected.'}`;
      deliveryStatus.className = 'setup-form-message error';
    } else if (server.welcomeDeliveryStatus === 'waiting') {
      deliveryStatus.textContent = server.welcomeDeliveryError || 'ERLY is retrying the welcome message.';
      deliveryStatus.className = 'setup-form-message';
    } else if (server.welcomeDeliveryStatus === 'sending') {
      deliveryStatus.textContent = 'A welcome message is being sent to a player who joined.';
      deliveryStatus.className = 'setup-form-message';
    } else {
      deliveryStatus.textContent = server.welcomeMessage
        ? 'ERLY is monitoring player joins for welcome messages.'
        : 'Save a welcome message to enable join monitoring.';
      deliveryStatus.className = 'setup-form-message';
    }
    document.title = `${server.serverName || 'Server configuration'} | ERLY`;
    message.textContent = '';
    saveButton.disabled = false;
  } catch (error) {
    message.textContent = error.message;
    message.className = 'setup-form-message error';
    if (error.message === 'Not signed in.') window.location.assign('/');
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (saveButton.disabled) return;
    saveButton.disabled = true;
    saveButton.textContent = 'Saving…';
    message.textContent = 'Saving your server details…';
    message.className = 'setup-form-message';

    try {
      const response = await fetch('/api/erlc/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: form.elements.displayName.value,
          welcomeMessage: form.elements.welcomeMessage.value
        })
      });
      await readApiResponse(response);
      window.location.assign('/dashboard.html');
    } catch (error) {
      message.textContent = error.message;
      message.className = 'setup-form-message error';
      saveButton.disabled = false;
      saveButton.textContent = 'Save and return to server';
    }
  });
});
