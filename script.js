document.addEventListener('DOMContentLoaded', () => {
  const loginForm = document.getElementById('loginForm');

  if (loginForm) {
    loginForm.addEventListener('submit', (event) => {
      event.preventDefault();
      window.location.href = 'dashboard.html';
    });
  }

  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach((item) => {
    item.addEventListener('click', () => {
      navItems.forEach((nav) => nav.classList.remove('active'));
      item.classList.add('active');
    });
  });

  const toast = document.querySelector('.toast');
  let toastTimer;
  const showToast = (message) => {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('visible');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 3200);
  };

  const authMessage = document.getElementById('auth-message');
  if (authMessage && new URLSearchParams(window.location.search).get('auth') === 'denied') {
    authMessage.textContent = 'Discord sign-in was cancelled. You can try again when you are ready.';
    authMessage.hidden = false;
  }

  const mapDialog = document.querySelector('[data-map-dialog]');
  const openMapDialog = document.querySelector('[data-open-map-dialog]');
  const closeMapDialog = document.querySelector('[data-close-map-dialog]');
  if (mapDialog && openMapDialog) {
    openMapDialog.addEventListener('click', () => mapDialog.showModal());
    closeMapDialog?.addEventListener('click', () => mapDialog.close());
    mapDialog.addEventListener('click', (event) => {
      if (event.target === mapDialog) mapDialog.close();
    });
  }

  const discordUsername = document.querySelector('[data-discord-username]');
  if (discordUsername) {
    fetch('/api/me')
      .then((response) => {
        if (response.status === 401) {
          window.location.assign('/');
          throw new Error('Your sign-in session expired. Please sign in again.');
        }
        if (!response.ok) throw new Error('Could not load your Discord profile.');
        return response.json();
      })
      .then(({ user }) => {
        discordUsername.textContent = user.displayName;
        const handle = document.querySelector('[data-discord-handle]');
        if (handle) handle.textContent = `@${user.username}`;
        const email = document.querySelector('[data-discord-email]');
        if (email) email.textContent = user.email || 'Email unavailable';
        const role = document.querySelector('[data-discord-role]');
        if (role) role.textContent = `@${user.username} · Discord`;
        const avatar = document.querySelector('[data-discord-avatar]');
        if (avatar) {
          avatar.textContent = user.avatar ? '' : user.displayName.slice(0, 1).toUpperCase();
          avatar.setAttribute('aria-label', `${user.displayName}'s Discord profile picture`);
          if (user.avatar) {
            const extension = user.avatar.startsWith('a_') ? 'gif' : 'png';
            avatar.style.backgroundImage = `url("https://cdn.discordapp.com/avatars/${encodeURIComponent(user.id)}/${encodeURIComponent(user.avatar)}.${extension}?size=96")`;
          } else {
            avatar.style.backgroundImage = '';
          }
        }
      })
      .catch((error) => {
        if (!window.location.pathname.endsWith('/')) showToast(error.message);
      });
  }

  const guildList = document.querySelector('[data-guild-list]');
  const guildListMessage = document.querySelector('[data-guild-list-message]');
  const guildsWithoutBot = guildList?.querySelector('[data-guild-column="missing"]');
  const guildsWithBot = guildList?.querySelector('[data-guild-column="present"]');
  const selectionSection = document.querySelector('[data-server-selection]');
  const profileSection = document.querySelector('[data-server-profile]');
  const keyDialog = document.querySelector('[data-erlc-key-dialog]');
  const keyForm = document.querySelector('[data-erlc-key-form]');
  const setupMessage = document.querySelector('[data-setup-message]');
  const confirmDialog = document.querySelector('[data-erlc-confirm-dialog]');
  const managementPanel = document.querySelector('[data-management-panel]');
  const inGameConfigDialog = document.querySelector('[data-ingame-config-dialog]');
  const inGameConfigForm = document.querySelector('[data-ingame-config-form]');
  const sessionChannelDialog = document.querySelector('[data-session-channel-dialog]');
  const sessionChannelForm = document.querySelector('[data-session-channel-form]');
  let selectedGuildId = '';
  let selectedProfile = null;
  let verifiedErlcServer = null;
  let currentManagementServer = null;
  let currentManagementServers = [];
  let currentSessionRange = '1h';
  let sessionMetricsRequestSequence = 0;

  const updateGuildCounts = () => {
    const missingCount = guildsWithoutBot?.children.length || 0;
    const presentCount = guildsWithBot?.children.length || 0;
    const missingCountLabel = guildList?.querySelector('[data-guild-count="missing"]');
    const presentCountLabel = guildList?.querySelector('[data-guild-count="present"]');
    if (missingCountLabel) missingCountLabel.textContent = String(missingCount);
    if (presentCountLabel) presentCountLabel.textContent = String(presentCount);
  };

  const placeGuildCard = (guild, card) => {
    const destination = guild.botPresent === true
      ? guildsWithBot
      : guild.botPresent === false
        ? guildsWithoutBot
        : null;
    destination?.append(card);
    updateGuildCounts();
  };

  const readApiResponse = async (response) => {
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data.message = text;
    }
    if (!response.ok) {
      const error = new Error(data.error || data.message || 'The server request failed.');
      error.statusCode = response.status;
      throw error;
    }
    return data;
  };

  const formatCount = (value) => Number.isInteger(value) ? value.toLocaleString() : 'Unavailable';

  const discordAssetUrl = (guildId, hash, assetType, size) => {
    const extension = hash.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/${assetType}/${encodeURIComponent(guildId)}/${encodeURIComponent(hash)}.${extension}?size=${size}`;
  };

  const setText = (selector, value) => {
    const element = document.querySelector(selector);
    if (element) element.textContent = value;
  };

  const renderWelcomeDeliveryStatus = (server) => {
    const status = server.welcomeDeliveryStatus;
    const detail = document.querySelector('[data-welcome-delivery-error]');
    if (status === 'error') {
      setText('[data-config-status]', 'Welcome message delivery needs attention.');
      if (detail) {
        detail.textContent = `ER:LC error: ${server.welcomeDeliveryError || 'The command was rejected.'}`;
        detail.className = 'setup-form-message error';
        detail.hidden = false;
      }
    } else if (status === 'waiting') {
      setText('[data-config-status]', 'ERLY is retrying the welcome message.');
      if (detail) {
        detail.textContent = server.welcomeDeliveryError || '';
        detail.className = 'setup-form-message';
        detail.hidden = !server.welcomeDeliveryError;
      }
    } else {
      setText('[data-config-status]', server.welcomeMessage
        ? status === 'sending'
          ? 'A welcome message is being sent to a player who joined.'
          : 'Welcome messages are active for players who join.'
        : 'Configure the welcome message players receive when they join.');
      if (detail) {
        detail.textContent = '';
        detail.hidden = true;
      }
    }
  };

  const renderUniquePlayerChart = (metrics) => {
    const chart = document.querySelector('[data-session-chart]');
    const message = document.querySelector('[data-session-chart-message]');
    if (!chart || !message) return;
    chart.replaceChildren();
    setText('[data-unique-player-count]', formatCount(metrics.totalUniquePlayers));

    const history = Array.isArray(metrics.history)
      ? metrics.history.filter((point) => Number.isFinite(point.timestamp) && Number.isInteger(point.uniquePlayers))
      : [];
    if (!history.length) {
      message.textContent = 'No player join data is available yet.';
      return;
    }

    const svgNamespace = 'http://www.w3.org/2000/svg';
    const width = 720;
    const height = 240;
    const left = 44;
    const right = 18;
    const top = 18;
    const bottom = 34;
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;
    const maxPlayers = Math.max(1, ...history.map((point) => point.uniquePlayers));
    const points = history.map((point, index) => ({
      x: history.length === 1 ? left + plotWidth / 2 : left + index / (history.length - 1) * plotWidth,
      y: top + plotHeight - point.uniquePlayers / maxPlayers * plotHeight,
      ...point
    }));

    for (let index = 0; index < 4; index += 1) {
      const y = top + index / 3 * plotHeight;
      const label = Math.round(maxPlayers * (1 - index / 3));
      const gridLine = document.createElementNS(svgNamespace, 'line');
      gridLine.setAttribute('x1', String(left));
      gridLine.setAttribute('x2', String(width - right));
      gridLine.setAttribute('y1', String(y));
      gridLine.setAttribute('y2', String(y));
      gridLine.setAttribute('class', 'session-chart-grid');
      chart.append(gridLine);

      const valueLabel = document.createElementNS(svgNamespace, 'text');
      valueLabel.setAttribute('x', String(left - 10));
      valueLabel.setAttribute('y', String(y + 4));
      valueLabel.setAttribute('text-anchor', 'end');
      valueLabel.setAttribute('class', 'session-chart-label');
      valueLabel.textContent = String(label);
      chart.append(valueLabel);
    }

    const line = document.createElementNS(svgNamespace, 'polyline');
    line.setAttribute('points', points.map((point) => `${point.x},${point.y}`).join(' '));
    line.setAttribute('class', 'session-chart-line');
    chart.append(line);
    points.forEach((point) => {
      const dot = document.createElementNS(svgNamespace, 'circle');
      dot.setAttribute('cx', String(point.x));
      dot.setAttribute('cy', String(point.y));
      dot.setAttribute('r', '4');
      dot.setAttribute('class', 'session-chart-point');
      chart.append(dot);
    });

    const firstLabel = document.createElementNS(svgNamespace, 'text');
    firstLabel.setAttribute('x', String(left));
    firstLabel.setAttribute('y', String(height - 8));
    firstLabel.setAttribute('class', 'session-chart-label');
    const timeLabelOptions = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
    firstLabel.textContent = new Date(points[0].timestamp).toLocaleString(undefined, timeLabelOptions);
    chart.append(firstLabel);

    const lastLabel = document.createElementNS(svgNamespace, 'text');
    lastLabel.setAttribute('x', String(width - right));
    lastLabel.setAttribute('y', String(height - 8));
    lastLabel.setAttribute('text-anchor', 'end');
    lastLabel.setAttribute('class', 'session-chart-label');
    lastLabel.textContent = new Date(points[points.length - 1].timestamp).toLocaleString(undefined, timeLabelOptions);
    chart.append(lastLabel);
    message.textContent = metrics.totalUniquePlayers
      ? `Unique players by ${metrics.bucketLabel} for the last ${metrics.rangeLabel}, based on join logs available from ER:LC.`
      : `No unique player joins were found in the available logs for the last ${metrics.rangeLabel}.`;
  };

  const refreshSessionMetrics = async (server = currentManagementServer) => {
    if (!server?.sessionChannelId) return;
    const requestSequence = ++sessionMetricsRequestSequence;
    const requestedRange = currentSessionRange;
    const message = document.querySelector('[data-session-chart-message]');
    if (message) {
      message.textContent = 'Loading player join history…';
      message.className = 'session-chart-message';
    }
    try {
      const query = new URLSearchParams({
        range: requestedRange,
        guild_id: server.guildId
      });
      const response = await fetch(`/api/erlc/session-metrics?${query}`);
      const metrics = await readApiResponse(response);
      if (requestSequence !== sessionMetricsRequestSequence) return;
      renderUniquePlayerChart(metrics);
    } catch (error) {
      if (requestSequence !== sessionMetricsRequestSequence) return;
      setText('[data-unique-player-count]', '—');
      if (message) {
        message.textContent = error.message;
        message.className = 'session-chart-message error';
      }
    }
  };
  document.querySelectorAll('[data-session-range]').forEach((button) => {
    button.addEventListener('click', () => {
      currentSessionRange = button.dataset.sessionRange;
      document.querySelectorAll('[data-session-range]').forEach((rangeButton) => {
        const selected = rangeButton === button;
        rangeButton.classList.toggle('active', selected);
        rangeButton.setAttribute('aria-pressed', String(selected));
      });
      void refreshSessionMetrics();
    });
  });

  const clearSelectedGuild = () => {
    selectedGuildId = '';
    selectedProfile = null;
    profileSection.hidden = true;
    guildList?.querySelectorAll('.guild-card').forEach((card) => card.classList.remove('selected'));
  };

  const showManagementPanel = (server) => {
    const shouldRefreshMetrics = server.sessionChannelId &&
      (currentManagementServer?.guildId !== server.guildId ||
        currentManagementServer?.sessionChannelId !== server.sessionChannelId);
    currentManagementServer = server;
    currentManagementServers = [
      server,
      ...currentManagementServers.filter((savedServer) => savedServer.guildId !== server.guildId)
    ];
    selectionSection.hidden = true;
    profileSection.hidden = true;
    managementPanel.hidden = false;
    setText('[data-management-server-name]', server.serverName);
    setText('[data-management-discord-name]', server.discordGuildName);
    setText('[data-management-owner]', server.ownerRobloxUsername);
    setText('[data-management-join-code]', server.joinCode);
    renderWelcomeDeliveryStatus(server);
    const sessionDashboard = document.querySelector('[data-session-dashboard]');
    if (sessionDashboard) {
      sessionDashboard.hidden = !server.sessionChannelId;
      setText('[data-session-channel-name]', server.sessionChannelName ? `#${server.sessionChannelName}` : 'Configured channel');
      if (shouldRefreshMetrics) void refreshSessionMetrics(server);
    }
    document.title = `${server.serverName} | ERLY`;
  };

  const showGuildProfile = async (guild) => {
    selectedGuildId = guild.id;
    profileSection.hidden = true;
    guildListMessage.textContent = `Loading ${guild.name} server details…`;
    try {
      const response = await fetch(`/api/guilds/${encodeURIComponent(guild.id)}/profile`);
      selectedProfile = await readApiResponse(response);
      guild.botPresent = true;
      setText('[data-profile-name]', selectedProfile.name);
      setText('[data-profile-description]', selectedProfile.description || 'This server has not added a description.');
      setText('[data-profile-members]', formatCount(selectedProfile.approximateMemberCount));
      setText('[data-profile-online]', formatCount(selectedProfile.approximatePresenceCount));
      setText('[data-profile-boosts]', formatCount(selectedProfile.boostCount));
      setText('[data-profile-created]', new Date(selectedProfile.createdAt).toLocaleDateString());
      const verificationLabels = ['None', 'Low', 'Medium', 'High', 'Highest'];
      setText('[data-profile-verification]', verificationLabels[selectedProfile.verificationLevel] || 'Unavailable');
      setText('[data-profile-locale]', selectedProfile.preferredLocale || 'Unavailable');
      const featureLabels = selectedProfile.features.length
        ? selectedProfile.features.map((feature) => feature.replaceAll('_', ' ').toLowerCase()).join(' · ')
        : 'No public server features';
      setText('[data-profile-features]', featureLabels);

      const icon = document.querySelector('[data-profile-icon]');
      const iconFallback = document.querySelector('[data-profile-icon-fallback]');
      if (selectedProfile.icon) {
        icon.src = discordAssetUrl(guild.id, selectedProfile.icon, 'icons', 128);
        icon.hidden = false;
        iconFallback.hidden = true;
      } else {
        icon.hidden = true;
        iconFallback.hidden = false;
        iconFallback.textContent = selectedProfile.name.slice(0, 1).toUpperCase();
      }

      const banner = document.querySelector('[data-profile-banner]');
      if (selectedProfile.banner) {
        banner.style.backgroundImage = `url("${discordAssetUrl(guild.id, selectedProfile.banner, 'banners', 1024)}")`;
        banner.hidden = false;
      } else {
        banner.style.backgroundImage = '';
        banner.hidden = true;
      }
      guildListMessage.textContent = 'Discord server details loaded.';
      const card = guildList.querySelector(`[data-guild-id="${CSS.escape(guild.id)}"]`);
      const badge = card?.querySelector('.status-pill');
      if (badge) {
        badge.classList.remove('warning');
        badge.classList.add('good');
        badge.textContent = 'ERLY bot added';
      }
      card?.querySelector('[data-add-bot]')?.remove();
      card?.querySelector('.guild-permission-note')?.remove();
      const selectButton = card?.querySelector('.guild-card-actions button');
      if (selectButton) selectButton.textContent = 'Select server';
      if (card) placeGuildCard(guild, card);
      const savedServer = currentManagementServers.find((server) => server.guildId === guild.id);
      if (savedServer) {
        const savedResponse = await fetch(`/api/erlc/current?guild_id=${encodeURIComponent(guild.id)}`);
        const savedData = await readApiResponse(savedResponse);
        showManagementPanel(savedData.server);
        return;
      }
      profileSection.hidden = false;
      profileSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (error) {
      guildListMessage.textContent = error.message;
      if (error.statusCode === 409) {
        guild.botPresent = false;
        const card = guildList.querySelector(`[data-guild-id="${CSS.escape(guild.id)}"]`);
        const badge = card?.querySelector('.status-pill');
        if (badge) {
          badge.classList.remove('good');
          badge.classList.add('warning');
          badge.textContent = 'Bot not added';
        }
        const permissionNote = card?.querySelector('.guild-permission-note');
        if (permissionNote) permissionNote.textContent = 'Ask a server admin to add the bot.';
        const selectButton = card?.querySelector('.guild-card-actions button');
        if (selectButton) selectButton.textContent = 'Retry check';
        if (guild.canManage && guild.botInviteUrl && card && !card.querySelector('[data-add-bot]')) {
          const invite = document.createElement('a');
          invite.className = 'primary-btn small-btn';
          invite.dataset.addBot = '';
          invite.textContent = 'Add ERLY bot';
          invite.href = guild.botInviteUrl;
          invite.target = '_blank';
          invite.rel = 'noopener noreferrer';
          card.querySelector('.guild-card-actions')?.prepend(invite);
        }
        if (card) placeGuildCard(guild, card);
      }
    }
  };

  const createGuildCard = (guild) => {
    const card = document.createElement('article');
    card.className = 'panel guild-card';
    card.dataset.guildId = guild.id;

    const header = document.createElement('div');
    header.className = 'guild-card-header';
    const identity = document.createElement('div');
    identity.className = 'guild-identity';

    if (guild.icon) {
      const icon = document.createElement('img');
      icon.className = 'guild-icon';
      icon.src = `https://cdn.discordapp.com/icons/${encodeURIComponent(guild.id)}/${encodeURIComponent(guild.icon)}.png?size=96`;
      icon.alt = '';
      icon.loading = 'lazy';
      identity.append(icon);
    } else {
      const icon = document.createElement('span');
      icon.className = 'guild-icon guild-icon-fallback';
      icon.textContent = guild.name.slice(0, 1).toUpperCase();
      identity.append(icon);
    }

    const name = document.createElement('h3');
    name.textContent = guild.name;
    identity.append(name);
    header.append(identity);

    const badge = document.createElement('span');
    badge.className = 'status-pill';
    if (guild.botPresent === true) {
      badge.classList.add('good');
      badge.textContent = 'ERLY bot added';
    } else if (guild.botPresent === false) {
      badge.classList.add('warning');
      badge.textContent = 'Bot not added';
    } else {
      badge.classList.add('warning');
      badge.textContent = guild.membershipCheckFailed ? 'Check failed' : 'Check on selection';
    }
    header.append(badge);
    card.append(header);

    const detail = document.createElement('p');
    detail.className = 'guild-detail';
    const role = guild.owner ? 'You own this server' : guild.canManage ? 'You can manage this server' : 'Server member';
    const count = Number.isInteger(guild.approximateMemberCount)
      ? ` · ${guild.approximateMemberCount.toLocaleString()} members`
      : '';
    detail.textContent = `${role}${count}`;
    card.append(detail);

    const actions = document.createElement('div');
    actions.className = 'guild-card-actions';

    if (guild.botPresent === false && guild.canManage && guild.botInviteUrl) {
      const invite = document.createElement('a');
      invite.className = 'primary-btn small-btn';
      invite.dataset.addBot = '';
      invite.textContent = 'Add ERLY bot';
      invite.href = guild.botInviteUrl;
      invite.target = '_blank';
      invite.rel = 'noopener noreferrer';
      invite.addEventListener('click', () => {
        selectedGuildId = guild.id;
        guildList.querySelectorAll('.guild-card').forEach((item) => item.classList.remove('selected'));
        card.classList.add('selected');
        profileSection.hidden = true;
        guildListMessage.textContent = `Add ERLY to ${guild.name} in Discord, then return here.`;
      });
      actions.append(invite);
    } else if (guild.botPresent !== true) {
      const note = document.createElement('span');
      note.className = 'muted guild-permission-note';
      note.textContent = guild.botPresent === false
        ? 'Ask a server admin to add the bot.'
        : 'Server admins can add ERLY; verify the bot token afterward.';
      actions.append(note);
    }

    const select = document.createElement('button');
    select.className = 'ghost-btn small-btn';
    select.type = 'button';
    select.textContent = guild.botPresent === true
      ? 'Select server'
      : guild.botPresent === false
        ? 'Retry check'
        : 'Check & select';
    select.addEventListener('click', () => {
      guildList.querySelectorAll('.guild-card').forEach((item) => item.classList.remove('selected'));
      card.classList.add('selected');
      showGuildProfile(guild);
    });
    actions.append(select);
    card.append(actions);
    placeGuildCard(guild, card);
    return card;
  };

  const loadGuilds = async (forceRefresh = false) => {
    if (!guildList || !guildListMessage || !guildsWithoutBot || !guildsWithBot) return;
    guildsWithoutBot.replaceChildren();
    guildsWithBot.replaceChildren();
    updateGuildCounts();
    guildListMessage.textContent = 'Loading your Discord servers…';

    try {
      const response = await fetch(`/api/guilds${forceRefresh ? '?refresh=1' : ''}`);
      const data = await readApiResponse(response);

      if (!data.guilds.length) {
        guildListMessage.textContent = 'No Discord servers were returned for this account.';
        return;
      }

      if (data.botConfigured) {
        guildListMessage.textContent = `${data.guilds.length} Discord server${data.guilds.length === 1 ? '' : 's'} found. Checking ERLY membership…`;
      } else {
        guildListMessage.textContent = 'ERLY membership cannot be checked because the bot is not configured. Add DISCORD_BOT_TOKEN to your local .env to classify these servers.';
        return;
      }

      let nextGuildIndex = 0;
      let checkedCount = 0;
      let membershipFailures = 0;
      const membershipErrorMessages = new Set();
      const membershipErrorNames = [];
      let selectedGuildProfilePromise = null;
      const checkMembership = async () => {
        while (nextGuildIndex < data.guilds.length) {
          const guild = data.guilds[nextGuildIndex];
          nextGuildIndex += 1;
          if (data.botConfigured) {
            try {
              const membershipResponse = await fetch(`/api/guilds/${encodeURIComponent(guild.id)}/membership`);
              const membership = await readApiResponse(membershipResponse);
              if (typeof membership.botPresent !== 'boolean') {
                throw new Error('Discord returned an invalid membership status.');
              }
              guild.botPresent = membership.botPresent;
            } catch (error) {
              guild.botPresent = null;
              guild.membershipCheckFailed = true;
              membershipFailures += 1;
              membershipErrorNames.push(guild.name);
              membershipErrorMessages.add(error.message);
            }
          }

          const card = guild.botPresent === true || guild.botPresent === false
            ? createGuildCard(guild)
            : null;
          checkedCount += 1;
          if (selectedGuildId === guild.id && profileSection.hidden && !selectedGuildProfilePromise) {
            card?.classList.add('selected');
            selectedGuildProfilePromise = showGuildProfile(guild);
          }

          if (data.botConfigured && profileSection.hidden) {
            guildListMessage.textContent = `Checking ERLY membership… ${checkedCount} of ${data.guilds.length} servers checked.`;
          }
        }
      };

      const workerCount = data.botConfigured ? Math.min(4, data.guilds.length) : 1;
      await Promise.all(Array.from({ length: workerCount }, () => checkMembership()));
      if (selectedGuildProfilePromise) await selectedGuildProfilePromise;

      if (profileSection.hidden) {
        if (!selectedGuildProfilePromise) {
          if (membershipFailures) {
            const firstError = membershipErrorMessages.values().next().value;
            const failedNames = membershipErrorNames.slice(0, 5).join(', ');
            const omittedCount = membershipErrorNames.length - 5;
            const omittedNames = omittedCount > 0 ? `, and ${omittedCount} more` : '';
            guildListMessage.textContent = `Could not verify ERLY membership for ${failedNames}${omittedNames}. ${firstError} Unverified servers are not placed in either column; refresh to retry.`;
          } else if (data.botConfigured) {
            const presentCount = guildsWithBot.children.length;
            const missingCount = guildsWithoutBot.children.length;
            guildListMessage.textContent = `${presentCount} server${presentCount === 1 ? '' : 's'} with ERLY · ${missingCount} server${missingCount === 1 ? '' : 's'} without ERLY.`;
          }
        }

        if (selectedGuildId) {
          const selectedGuild = data.guilds.find((guild) => guild.id === selectedGuildId);
          if (selectedGuild && !selectedGuildProfilePromise) {
            const card = guildList.querySelector(`[data-guild-id="${CSS.escape(selectedGuild.id)}"]`);
            card?.classList.add('selected');
            await showGuildProfile(selectedGuild);
          }
        }
      }
    } catch (error) {
      guildListMessage.textContent = error.message;
      if (responseNeedsGuildReauth(error.message)) {
        const login = document.createElement('a');
        login.className = 'text-link';
        login.href = '/auth/logout';
        login.textContent = 'Sign out, then sign in again to grant server-list access.';
        guildListMessage.append(' ');
        guildListMessage.append(login);
      }
    }
  };

  function responseNeedsGuildReauth(message) {
    return message.includes('sign in again to grant the guilds permission');
  }

  const refreshGuilds = document.querySelector('[data-refresh-guilds]');
  if (refreshGuilds) refreshGuilds.addEventListener('click', () => loadGuilds(true));
  window.addEventListener('focus', () => {
    if (guildList && selectedGuildId && managementPanel.hidden) {
      guildListMessage.textContent = 'Checking whether ERLY was added…';
      loadGuilds(true);
    }
  });

  document.querySelector('[data-confirm-discord]')?.addEventListener('click', () => {
    if (!selectedProfile || !selectedGuildId) return;
    setupMessage.textContent = '';
    setupMessage.className = 'setup-form-message';
    keyForm.reset();
    keyDialog.showModal();
  });

  document.querySelector('[data-reject-discord]')?.addEventListener('click', clearSelectedGuild);
  document.querySelector('[data-close-key-dialog]')?.addEventListener('click', () => keyDialog.close());

  if (keyForm) {
    keyForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const submit = keyForm.querySelector('[data-verify-erlc]');
      const formData = new FormData(keyForm);
      submit.disabled = true;
      submit.textContent = 'Verifying with ER:LC…';
      setupMessage.textContent = 'Checking the server and Roblox owner with the official APIs…';
      setupMessage.className = 'setup-form-message';

      try {
        const response = await fetch('/api/erlc/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            discordGuildId: selectedGuildId,
            serverApiKey: formData.get('serverApiKey')
          })
        });
        verifiedErlcServer = await readApiResponse(response);
        keyForm.reset();
        keyDialog.close();
        setText('[data-confirm-server-name]', verifiedErlcServer.serverName);
        setText('[data-confirm-owner]', verifiedErlcServer.ownerRobloxUsername);
        setText('[data-confirm-join-code]', verifiedErlcServer.joinCode);
        setText('[data-confirm-message]', '');
        confirmDialog.showModal();
      } catch (error) {
        setupMessage.replaceChildren(document.createTextNode(error.message));
        setupMessage.className = 'setup-form-message error';
        if (error.statusCode === 429 || error.statusCode >= 500) {
          const retry = document.createElement('button');
          retry.className = 'ghost-btn small-btn';
          retry.type = 'button';
          retry.textContent = 'Retry verification';
          retry.addEventListener('click', () => keyForm.requestSubmit());
          setupMessage.append(' ', retry);
        }
      } finally {
        submit.disabled = false;
        submit.textContent = 'Verify ER:LC server';
      }
    });
  }

  const finishErlcConfirmation = async (confirmed) => {
    if (!verifiedErlcServer) return;
    const message = document.querySelector('[data-confirm-message]');
    const buttons = confirmDialog.querySelectorAll('[data-confirm-erlc], [data-reject-erlc]');
    buttons.forEach((button) => { button.disabled = true; });
    message.textContent = confirmed ? 'Saving your verified server…' : 'Returning to server selection…';
    message.className = 'setup-form-message';
    try {
      const response = await fetch('/api/erlc/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ discordGuildId: verifiedErlcServer.guildId, confirmed })
      });
      const result = await readApiResponse(response);
      confirmDialog.close();
      if (confirmed) {
        verifiedErlcServer = result.server;
        showManagementPanel(verifiedErlcServer);
        openInGameConfig();
      } else {
        verifiedErlcServer = null;
        clearSelectedGuild();
        guildListMessage.textContent = 'Choose a Discord server to continue.';
      }
    } catch (error) {
      message.textContent = error.message;
      message.className = 'setup-form-message error';
    } finally {
      buttons.forEach((button) => { button.disabled = false; });
    }
  };

  document.querySelector('[data-confirm-erlc]')?.addEventListener('click', () => finishErlcConfirmation(true));
  document.querySelector('[data-reject-erlc]')?.addEventListener('click', () => finishErlcConfirmation(false));
  document.querySelector('[data-close-erlc-confirm]')?.addEventListener('click', () => finishErlcConfirmation(false));

  const showInGameConfigStep = (step) => {
    inGameConfigDialog.querySelectorAll('[data-config-step]').forEach((section) => {
      const isHidden = section.dataset.configStep !== step;
      section.hidden = isHidden;
      section.querySelectorAll('input, textarea').forEach((field) => {
        field.disabled = isHidden;
      });
    });
  };
  const inGameConfigMessage = document.querySelector('[data-ingame-config-message]');
  const openInGameConfig = () => {
    if (!currentManagementServer || !inGameConfigForm) return;
    inGameConfigForm.elements.welcomeMessage.value = currentManagementServer.welcomeMessage || '';
    inGameConfigForm.elements.displayName.value = currentManagementServer.serverName || '';
    inGameConfigMessage.textContent = '';
    inGameConfigMessage.className = 'setup-form-message';
    showInGameConfigStep('welcome');
    inGameConfigDialog.showModal();
  };
  const sessionChannelSelect = sessionChannelForm?.elements.sessionChannelId;
  const sessionChannelMessage = document.querySelector('[data-session-channel-message]');
  const loadSessionChannels = async () => {
    if (!currentManagementServer?.guildId || !sessionChannelSelect) return;
    sessionChannelDialog.showModal();
    sessionChannelSelect.disabled = true;
    sessionChannelSelect.replaceChildren(new Option('Loading server channels…', ''));
    sessionChannelMessage.textContent = 'Loading text and announcement channels…';
    sessionChannelMessage.className = 'setup-form-message';
    try {
      const response = await fetch(`/api/guilds/${encodeURIComponent(currentManagementServer.guildId)}/channels`);
      const data = await readApiResponse(response);
      sessionChannelSelect.replaceChildren();
      const groups = new Map();
      for (const channel of data.channels) {
        const groupName = channel.categoryName || 'Channels';
        let group = groups.get(groupName);
        if (!group) {
          group = document.createElement('optgroup');
          group.label = groupName;
          groups.set(groupName, group);
          sessionChannelSelect.append(group);
        }
        const option = document.createElement('option');
        option.value = channel.id;
        option.textContent = `# ${channel.name}`;
        group.append(option);
      }
      if (!data.channels.length) {
        sessionChannelSelect.append(new Option('No text channels available', ''));
        sessionChannelMessage.textContent = 'This server has no text or announcement channels available to ERLY.';
        sessionChannelMessage.className = 'setup-form-message error';
      } else {
        sessionChannelSelect.value = currentManagementServer.sessionChannelId || data.channels[0].id;
        sessionChannelMessage.textContent = 'Select where session notifications should be posted.';
      }
    } catch (error) {
      sessionChannelSelect.replaceChildren(new Option('Could not load channels', ''));
      sessionChannelMessage.textContent = error.message;
      sessionChannelMessage.className = 'setup-form-message error';
    } finally {
      sessionChannelSelect.disabled = false;
    }
  };
  document.querySelector('[data-open-session-dialog]')?.addEventListener('click', () => {
    void loadSessionChannels();
  });
  document.querySelector('[data-close-session-dialog]')?.addEventListener('click', () => sessionChannelDialog.close());
  document.querySelector('[data-cancel-session-dialog]')?.addEventListener('click', () => sessionChannelDialog.close());
  sessionChannelDialog?.addEventListener('click', (event) => {
    if (event.target === sessionChannelDialog) sessionChannelDialog.close();
  });
  sessionChannelForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const saveButton = sessionChannelForm.querySelector('[data-save-session-channel]');
    const channelId = new FormData(sessionChannelForm).get('sessionChannelId');
    if (typeof channelId !== 'string' || !channelId) {
      sessionChannelMessage.textContent = 'Choose a channel before saving.';
      sessionChannelMessage.className = 'setup-form-message error';
      return;
    }
    saveButton.disabled = true;
    saveButton.textContent = 'Saving…';
    sessionChannelMessage.textContent = 'Saving your session channel…';
    sessionChannelMessage.className = 'setup-form-message';
    try {
      const response = await fetch('/api/erlc/session-channel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId })
      });
      const result = await readApiResponse(response);
      sessionChannelDialog.close();
      showManagementPanel(result.server);
      showToast(`Session notifications will be sent to #${result.server.sessionChannelName}.`);
    } catch (error) {
      sessionChannelMessage.textContent = error.message;
      sessionChannelMessage.className = 'setup-form-message error';
    } finally {
      saveButton.disabled = false;
      saveButton.textContent = 'Save channel';
    }
  });
  document.querySelector('[data-refresh-session-metrics]')?.addEventListener('click', () => {
    void refreshSessionMetrics();
  });
  document.querySelectorAll('[data-session-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      const message = document.querySelector('[data-session-action-message]');
      const buttons = document.querySelectorAll('[data-session-action]');
      buttons.forEach((actionButton) => { actionButton.disabled = true; });
      message.textContent = 'Sending session notification…';
      message.className = 'setup-form-message';
      try {
        const response = await fetch('/api/erlc/session-notifications', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: button.dataset.sessionAction })
        });
        await readApiResponse(response);
        message.textContent = `${button.textContent} notification sent to #${currentManagementServer.sessionChannelName}.`;
      } catch (error) {
        message.textContent = error.message;
        message.className = 'setup-form-message error';
      } finally {
        buttons.forEach((actionButton) => { actionButton.disabled = false; });
      }
    });
  });
  document.querySelector('[data-open-ingame-config]')?.addEventListener('click', openInGameConfig);
  document.querySelector('[data-close-ingame-config]')?.addEventListener('click', () => inGameConfigDialog.close());
  inGameConfigDialog?.addEventListener('click', (event) => {
    if (event.target === inGameConfigDialog) inGameConfigDialog.close();
  });
  document.querySelector('[data-config-next]')?.addEventListener('click', () => {
    const welcomeMessage = inGameConfigForm.elements.welcomeMessage.value.trim().replace(/\s+/g, ' ');
    if (!welcomeMessage) {
      inGameConfigForm.elements.welcomeMessage.focus();
      inGameConfigMessage.textContent = 'Enter a welcome message before continuing.';
      inGameConfigMessage.className = 'setup-form-message error';
      return;
    }
    inGameConfigForm.elements.welcomeMessage.value = welcomeMessage;
    inGameConfigMessage.textContent = '';
    inGameConfigMessage.className = 'setup-form-message';
    showInGameConfigStep('name');
    inGameConfigForm.elements.displayName.focus();
  });
  document.querySelector('[data-config-back]')?.addEventListener('click', () => {
    inGameConfigMessage.textContent = '';
    inGameConfigMessage.className = 'setup-form-message';
    showInGameConfigStep('welcome');
  });
  inGameConfigForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const saveButton = inGameConfigForm.querySelector('[data-save-ingame-config]');
    const welcomeMessage = inGameConfigForm.elements.welcomeMessage.value.trim().replace(/\s+/g, ' ');
    const displayName = inGameConfigForm.elements.displayName.value;
    if (!welcomeMessage) {
      inGameConfigMessage.textContent = 'Enter a welcome message before saving.';
      inGameConfigMessage.className = 'setup-form-message error';
      return;
    }

    saveButton.disabled = true;
    saveButton.textContent = 'Saving…';
    inGameConfigMessage.textContent = 'Saving your in-game properties…';
    inGameConfigMessage.className = 'setup-form-message';
    try {
      const response = await fetch('/api/erlc/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ welcomeMessage, displayName })
      });
      const result = await readApiResponse(response);
      showManagementPanel(result.server);
      inGameConfigDialog.close();
      showToast('In-game properties saved. New players will receive your private welcome message.');
    } catch (error) {
      inGameConfigMessage.textContent = error.message;
      inGameConfigMessage.className = 'setup-form-message error';
    } finally {
      saveButton.disabled = false;
      saveButton.textContent = 'Save server name';
    }
  });

  if (guildList) {
    const restoreSetup = async () => {
      try {
        const response = await fetch('/api/erlc/current');
        const data = await readApiResponse(response);
        currentManagementServers = Array.isArray(data.servers)
          ? data.servers
          : data.server ? [data.server] : [];
        await loadGuilds();
      } catch (error) {
        guildListMessage.textContent = error.message;
      }
    };
    restoreSetup();
    window.setInterval(async () => {
      if (managementPanel.hidden || document.hidden) return;
      try {
        const selectedServerQuery = currentManagementServer?.guildId
          ? `?guild_id=${encodeURIComponent(currentManagementServer.guildId)}`
          : '';
        const response = await fetch(`/api/erlc/current${selectedServerQuery}`);
        const data = await readApiResponse(response);
        if (data.server) showManagementPanel(data.server);
      } catch (error) {
        setText('[data-config-status]', 'Delivery status could not be refreshed.');
        const detail = document.querySelector('[data-welcome-delivery-error]');
        if (detail) {
          detail.textContent = error.message;
          detail.className = 'setup-form-message error';
          detail.hidden = false;
        }
      }
    }, 10_000);
  }
  document.querySelectorAll('[data-demo-action]').forEach((button) => {
    button.addEventListener('click', () => {
      showToast(`${button.dataset.demoAction} is a preview action. Connect the ERLY backend to enable it.`);
    });
  });

  document.querySelectorAll('[data-demo-form]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      showToast(`${form.dataset.demoForm} saved in this preview only. No external service was changed.`);
    });
  });

  document.querySelectorAll('[data-filter]').forEach((input) => {
    input.addEventListener('input', () => {
      const table = document.getElementById(input.dataset.filter);
      if (!table) return;
      const query = input.value.trim().toLowerCase();
      table.querySelectorAll('tbody tr').forEach((row) => {
        row.hidden = !row.textContent.toLowerCase().includes(query);
      });
    });
  });
});
