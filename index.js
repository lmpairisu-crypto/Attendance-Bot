require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const {
  Client, GatewayIntentBits, Partials, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, Events, PermissionsBitField
} = require('discord.js');
const config = require('./config.json');
const TOKEN = process.env.DISCORD_TOKEN;
const DATA_PATH = path.join(__dirname, 'data.json');
const COLOR = process.env.EMBED_COLOR || config.embedColor || '#D4AF37';
const REMINDER_MINUTES = Math.max(5, Number(process.env.REMINDER_INTERVAL_MINUTES || config.reminderIntervalMinutes || 360));
const VERIFY_ID = 'lmp_attendance_verify_v1';
if (!TOKEN || TOKEN === 'PUT_YOUR_BOT_TOKEN_HERE') {
  console.error('❌ DISCORD_TOKEN is missing. Add it in your host Environment settings.');
  process.exit(1);
}
const channelById = new Map(config.submissionChannels.map(c => [String(c.id), c]));
function freshData() { return { users: {}, setupMessages: {}, completedAnnouncements: {} }; }
function loadData() {
  try {
    if (!fs.existsSync(DATA_PATH)) return freshData();
    const d = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    return { users: d.users || {}, setupMessages: d.setupMessages || {}, completedAnnouncements: d.completedAnnouncements || {} };
  } catch (e) { console.error('Could not read data.json:', e.message); return freshData(); }
}
let data = loadData();
let saveTimer;
function saveData() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DATA_PATH + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify(data, null, 2)); fs.renameSync(tmp, DATA_PATH); }
    catch (e) { console.error('Could not save data.json:', e.message); }
  }, 150);
}
function ensureUser(id, username) {
  id = String(id);
  if (!data.users[id]) data.users[id] = { username, channels: {}, reminderMessageId: null, lastReminderAt: 0 };
  else if (username) data.users[id].username = username;
  return data.users[id];
}
function done(user, id) { return Boolean(user?.channels?.[String(id)]?.completedAt); }
function missing(user) { return config.submissionChannels.filter(c => !done(user, c.id)); }
function row() { return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(VERIFY_ID).setLabel('Verify My Attendance').setStyle(ButtonStyle.Success).setEmoji('✅')); }
function embed(title, description) { return new EmbedBuilder().setColor(COLOR).setTitle(title).setDescription(description).setTimestamp(); }
function instructionEmbed(c) {
  return embed(c.title, c.description).addFields(
    { name: 'Required Details', value: c.details.map(x => '• ' + x).join('\n').slice(0, 1024) },
    { name: 'Example Submission', value: ('```text\n' + c.example + '\n```').slice(0, 1024) },
    { name: 'Reminder', value: c.reminder || 'Please follow the required format.' }
  ).setFooter({ text: 'LMP • DIARIES — Attendance Submission' });
}
function attendanceEmbed() {
  return embed('📋 LMP Attendance System', 'Welcome to the LMP Attendance System! This system tracks your progress through all seven required submission channels to help keep your creator information organized and up to date.')
    .addFields(
      { name: 'How the Attendance System Works', value: [
        '**Complete all 7 channels.** Submit your information in each designated channel using its required format.',
        '**Automatic submission tracking.** The bot checks your messages against each channel’s submission requirements and records your progress.',
        '**Incomplete attendance reminders.** If you have missing submissions, the bot will notify you and list the channels you still need to complete.',
        '**Progress verification.** Once all seven channels are complete, the bot will provide an attendance verification button.',
        '**Check your own attendance.** Use the verification button to view your recorded progress and completion status.'
      ].join('\n\n') },
      { name: '📌 Required Submissions', value: [
        '• **Creator Start** — Old account, creator start date, and rejoining date (or `N/A`).',
        '• **Member Start** — LMP name and joining date.',
        '• **HOK Profile** — Screenshot of your Honor of Kings profile.',
        '• **Social Media Accounts** — Account names, platforms, and screenshots.',
        '• **Social Media Links** — Links to your social media accounts.',
        '• **Social Media Username** — Social media platforms and usernames.',
        '• **Signature Hero** — Hero name, requested changes (or `N/A`), and a classic/default hero image.'
      ].join('\n') },
      { name: '⚠️ Important Rules', value: [
        '• Follow the required format for each submission channel.',
        '• Submit all information and attachments required by that channel.',
        '• Do not use submission channels for casual conversations or replies.',
        '• The bot checks submission format and required content; it cannot automatically guarantee that all information is truthful or that a hero image uses the classic model.',
        '• Correct invalid or rejected submissions before relying on your attendance status.'
      ].join('\n') }
    ).setFooter({ text: 'LMP • DIARIES — Attendance Management' });
}
async function upsert(channel, key, payload) {
  const oldId = data.setupMessages[key];
  if (oldId) {
    try { const old = await channel.messages.fetch(oldId); await old.edit(payload); return old; }
    catch (_) { /* recreate missing setup message */ }
  }
  const msg = await channel.send(payload); data.setupMessages[key] = msg.id; saveData(); return msg;
}
async function setupEmbeds() {
  for (const c of config.submissionChannels) {
    try {
      const ch = await client.channels.fetch(String(c.id));
      if (!ch?.isTextBased() || !ch.messages) { console.error(`Cannot access ${c.name} (${c.id})`); continue; }
      await upsert(ch, 'submission:' + c.id, { embeds: [instructionEmbed(c)] });
      console.log('📌 Embed ready:', c.name);
    } catch (e) { console.error(`Could not set up ${c.name}:`, e.message); }
  }
  try {
    const report = await client.channels.fetch(String(config.reportChannelId));
    if (!report?.isTextBased() || !report.messages) { console.error('Cannot access attendance report channel'); return; }
    await upsert(report, 'attendance-report', { embeds: [attendanceEmbed()], components: [row()] });
    console.log('📋 Attendance report embed ready.');
  } catch (e) { console.error('Could not set up report embed:', e.message); }
}
function linesOf(s) { return String(s || '').replace(/\r/g, '').split('\n').map(x => x.trim()).filter(Boolean); }
function field(content, names) {
  const set = new Set(names.map(x => x.toLowerCase()));
  for (const line of linesOf(content)) {
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (m && set.has(m[1].trim().toLowerCase()) && m[2].trim()) return m[2].trim();
  }
  return null;
}
function stillImages(message) {
  return [...message.attachments.values()].every(a => {
    const type = (a.contentType || '').toLowerCase(), name = (a.name || '').toLowerCase();
    return type.startsWith('image/') && type !== 'image/gif' && !name.endsWith('.gif');
  }) && message.attachments.size > 0;
}
function hasBadMedia(message) {
  if (message.stickers?.size) return true;
  return [...message.attachments.values()].some(a => {
    const t = (a.contentType || '').toLowerCase(), n = (a.name || '').toLowerCase();
    return !t.startsWith('image/') || t === 'image/gif' || n.endsWith('.gif');
  });
}
function validate(c, m) {
  const content = m.content || '', lines = linesOf(content);
  if (m.reference) return { ok: false, reason: 'Replies are not allowed. Submit your own information as a new message.' };
  if (hasBadMedia(m)) return { ok: false, reason: 'GIFs, videos, and stickers are not allowed. Attach only media required by this channel.' };
  if (c.key === 'creatorStart') {
    if (!field(content, ['Old Account']) || !field(content, ['Creator Start', 'Creator Start Date']) || !field(content, ['Rejoining', 'Rejoining Date'])) return { ok: false, reason: 'Use the required Old Account, Creator Start, and Rejoining fields. Write N/A if rejoining does not apply.' };
    if (m.attachments.size) return { ok: false, reason: 'This channel requires text details only.' };
    return { ok: true };
  }
  if (c.key === 'memberStart') {
    const name = field(content, ['LMP Name']), date = field(content, ['Joining Date']);
    if (!name || !/lmp/i.test(name) || !date) return { ok: false, reason: 'Include LMP Name (with LMP in the name) and Joining Date in the required format.' };
    if (m.attachments.size) return { ok: false, reason: 'This channel requires text details only.' };
    return { ok: true };
  }
  if (c.key === 'hokProfile') {
    if (content.trim() || !stillImages(m)) return { ok: false, reason: 'Submit only a still screenshot image of your Honor of Kings profile, without extra text.' };
    return { ok: true };
  }
  if (c.key === 'socialAccounts') {
    const accounts = lines.filter(x => /^Account Name:\s*\S/i.test(x));
    const platforms = lines.filter(x => /^Social Media:\s*\S/i.test(x));
    if (!accounts.length || accounts.length !== platforms.length || !stillImages(m)) return { ok: false, reason: 'Use matching Account Name and Social Media lines for each account, and attach at least one screenshot.' };
    if (!lines.every(x => /^(Account Name|Social Media):\s*\S/i.test(x))) return { ok: false, reason: 'Only Account Name and Social Media fields are allowed in this submission.' };
    return { ok: true };
  }
  if (c.key === 'socialLinks') {
    if (m.attachments.size || !lines.length || !lines.every(x => /^(https?:\/\/|www\.)\S+$/i.test(x))) return { ok: false, reason: 'Submit only social media links, one URL per line. Do not add labels, images, or other text.' };
    return { ok: true };
  }
  if (c.key === 'socialUsernames') {
    if (m.attachments.size) return { ok: false, reason: 'This channel requires platform names and usernames as text only.' };
    const socials = lines.filter(x => /^Social Media:\s*\S/i.test(x));
    const usernames = lines.filter(x => /^Username:\s*\S/i.test(x));
    if (!socials.length || socials.length !== usernames.length || !lines.every(x => /^(Social Media|Username):\s*\S/i.test(x))) return { ok: false, reason: 'For each account, include Social Media: platform and Username: @yourname. Repeat for every account.' };
    return { ok: true };
  }
  if (c.key === 'signatureHero') {
    if (!field(content, ['Hero Name']) || !field(content, ['Request']) || !stillImages(m)) return { ok: false, reason: 'Include Hero Name and Request (write N/A if no changes are needed) and attach a still image of the classic/default hero.' };
    return { ok: true };
  }
  return { ok: false, reason: 'This channel does not have a validator configured.' };
}
async function deleteMessage(m) { try { if (m.deletable) await m.delete(); } catch (e) { console.warn('Could not delete message:', e.message); } }
async function notice(channel, userId, text) {
  try {
    const msg = await channel.send({ content: `⚠️ <@${userId}> Your message was removed: ${text}`, allowedMentions: { users: [String(userId)] } });
    setTimeout(() => msg.delete().catch(() => {}), 10000);
  } catch (e) { console.warn('Could not send moderation notice:', e.message); }
}
async function reportChannel() {
  const ch = await client.channels.fetch(String(config.reportChannelId)).catch(() => null);
  return ch?.isTextBased() && ch.send ? ch : null;
}
function reminderEmbed(userId, user) {
  const miss = missing(user);
  return embed('⚠️ LMP Attendance Reminder', `Hello <@${userId}>!\n\nYou still have **${miss.length} missing attendance submission${miss.length === 1 ? '' : 's'}**. Please complete the following channel${miss.length === 1 ? '' : 's'}:`)
    .addFields(
      { name: 'Missing Channels', value: miss.map(c => `• <#${c.id}> — **${c.title}**`).join('\n').slice(0, 1024) || 'None' },
      { name: 'What to do', value: 'Submit the required details in each channel using its correct example format. Once all seven are complete, your missing-submission reminders will stop.' }
    ).setFooter({ text: 'LMP • DIARIES — Attendance Reminder' });
}
async function removeReminder(user) {
  if (!user?.reminderMessageId) return;
  const report = await reportChannel();
  if (report) { try { const msg = await report.messages.fetch(user.reminderMessageId); await msg.delete(); } catch (_) {} }
  user.reminderMessageId = null; saveData();
}
async function updateReminder(userId, forcePing = false, announce = true) {
  const user = data.users[String(userId)]; if (!user) return;
  const miss = missing(user), report = await reportChannel(); if (!report) return;
  if (!miss.length) {
    await removeReminder(user);
    if (announce && !data.completedAnnouncements[String(userId)]) {
      try {
        await report.send({ embeds: [embed('✅ Attendance Completed!', `<@${userId}> has completed all **7 attendance submissions**.\n\nYour missing-attendance reminder has been removed. Use the **Verify My Attendance** button in this channel whenever you want to check your status.`)], components: [row()], allowedMentions: { users: [String(userId)] } });
        data.completedAnnouncements[String(userId)] = true; saveData();
      } catch (e) { console.error('Completion notice failed:', e.message); }
    }
    return;
  }
  if (user.reminderMessageId && !forcePing) {
    try { const old = await report.messages.fetch(user.reminderMessageId); await old.edit({ embeds: [reminderEmbed(userId, user)], allowedMentions: { parse: [] } }); return; }
    catch (_) { user.reminderMessageId = null; }
  }
  if (forcePing && user.reminderMessageId) await removeReminder(user);
  try {
    const msg = await report.send({ content: `<@${userId}>`, embeds: [reminderEmbed(userId, user)], allowedMentions: { users: [String(userId)] } });
    user.reminderMessageId = msg.id; user.lastReminderAt = Date.now(); saveData();
  } catch (e) { console.error('Reminder failed:', e.message); }
}
async function verify(interaction) {
  const user = data.users[String(interaction.user.id)];
  if (!user) return interaction.reply({ content: 'I have no attendance submissions recorded for you yet. Start by submitting in the required channels.', ephemeral: true });
  const completed = config.submissionChannels.filter(c => done(user, c.id)), miss = missing(user);
  const e = embed('📋 Your LMP Attendance Status', `Attendance progress for <@${interaction.user.id}>`)
    .addFields(
      { name: 'Progress', value: `**${completed.length} / ${config.submissionChannels.length} completed**` },
      { name: 'Completed Channels', value: completed.length ? completed.map(c => `✅ <#${c.id}> — ${c.title}`).join('\n').slice(0, 1024) : 'No completed submissions yet.' },
      { name: 'Missing Channels', value: miss.length ? miss.map(c => `❌ <#${c.id}> — ${c.title}`).join('\n').slice(0, 1024) : '🎉 All seven submissions are complete!' }
    ).setFooter({ text: 'LMP • DIARIES — Only you can see this status.' });
  return interaction.reply({ embeds: [e], ephemeral: true });
}
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions], partials: [Partials.Message, Partials.Channel, Partials.Reaction] });
client.once(Events.ClientReady, async c => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  await setupEmbeds();
  for (const id of Object.keys(data.users)) await updateReminder(id, false, false);
  setInterval(async () => {
    for (const [id, user] of Object.entries(data.users)) {
      if (!missing(user).length) { await updateReminder(id); continue; }
      if (Date.now() - Number(user.lastReminderAt || 0) >= REMINDER_MINUTES * 60000) await updateReminder(id, true);
    }
  }, Math.min(REMINDER_MINUTES, 30) * 60000);
});
client.on(Events.MessageCreate, async m => {
  if (!m.guild || m.author.bot) return;
  const c = channelById.get(String(m.channelId)); if (!c) return;
  const user = ensureUser(m.author.id, m.author.username), result = validate(c, m);
  if (!result.ok) {
    await deleteMessage(m);
    await notice(m.channel, m.author.id, result.reason);
    await updateReminder(m.author.id, false, false);
    return;
  }
  user.channels[String(c.id)] = { completedAt: Date.now(), messageId: m.id, channelId: String(c.id), channelName: c.name };
  // If someone fixes/replaces a submission after finishing, completion can be announced again only after a future state transition.
  if (missing(user).length) delete data.completedAnnouncements[String(m.author.id)];
  saveData();
  console.log(`✅ Accepted ${c.name} submission from ${m.author.tag}`);
  await updateReminder(m.author.id, false, true);
});
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (user.bot) return;
  try {
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();
    if (!reaction.message.guild || !channelById.has(String(reaction.message.channelId))) return;
    const me = reaction.message.guild.members.me;
    if (!me?.permissionsIn(reaction.message.channel).has(PermissionsBitField.Flags.ManageMessages)) return;
    await reaction.users.remove(user.id);
  } catch (e) { console.warn('Could not remove reaction:', e.message); }
});
client.on(Events.InteractionCreate, async i => {
  try { if (i.isButton() && i.customId === VERIFY_ID) await verify(i); }
  catch (e) {
    console.error('Interaction error:', e);
    if (i.isRepliable() && !i.replied && !i.deferred) await i.reply({ content: 'Something went wrong checking your attendance. Please try again.', ephemeral: true }).catch(() => {});
  }
});
process.on('unhandledRejection', e => console.error('Unhandled rejection:', e));
client.login(TOKEN);
