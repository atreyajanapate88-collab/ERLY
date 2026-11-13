import { REST, Routes, Client, GatewayIntentBits, Events, MessageFlags, EmbedBuilder, ActionRowBuilder, ButtonBuilder } from 'discord.js';
import { saveEncryptedJson, loadEncryptedJson } from './jsonCrypto.js';
import { ERLCClient } from '@erlcjs/core';
import { setTimeout as sleep } from 'node:timers/promises';

const TOKEN = 'YOUR_TOKEN_HERE';
const CLIENT_ID = 'YOUR_CLIENT_ID';

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent 
    ] 
});

const commands = [
    {
        name: 'erlc-connect',
        description: 'Connects to an ERLC server via an API',
        options: [
            {
                name: 'api_key',
                description: 'The API key for the ERLC server',
                type: 3, // STRING
                required: true
            }
        ]
    }, {
        name: 'session-start',
        description: 'Starts a session on the ERLC server',
        options: [
            {
                name: 'channel',
                description: 'The channel to start the session in',
                type: 7,
                required: true
            }
        ]
    }, {
        name: 'session-end',
        description: 'Ends the current session on the ERLC server',
        options: [
            {
                name: 'channel',
                description: 'The channel to end the session in',
                type: 7,
                required: true
            }
        ]
    }, {
        name: 'session-low',
        description: 'Sets the session to low population',
        options: [
            {
                name: 'channel',
                description: 'The channel to set the session to low population in',
                type: 7,
                required: true
            }
        ]
    }, {
        name: 'session-full',
        description: 'Sets the session to full population',
        options: [
            {
                name: 'channel',
                description: 'The channel to set the session to full population in',
                type: 7,
                required: true
            }
        ]
    }
];

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
    try {
        console.log('Refreshing (/) commands...');
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        console.log('Successfully reloaded (/) commands.');
    } catch (error) { console.error(error); }
})();

client.on('interactionCreate', async (interaction) => {
    if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'erlc-connect') {
            await interaction.deferReply({ ephemeral: true });
            if (interaction.user.id !== interaction.guild.ownerId) {
                await interaction.reply({ content: '❌ You do not have permission to use this command. Only the server owner can use it.', ephemeral: true });
                return;
            }

            const apiKey = interaction.options.getString('api_key');
            
            const servers = await loadEncryptedJson();

            servers[`${interaction.guild.id}`] = { 
                servername: interaction.guild.name,
                erlcApiKey: apiKey
             };
            
            await saveEncryptedJson(servers);
            
            await interaction.reply({ content: `✅ Successfully connected to the ERLC server with API key: ${apiKey}`, ephemeral: true });
        } else if (interaction.commandName === 'session-start') {
            await interaction.deferReply({ ephemeral: true });

            const channel = interaction.options.getChannel('channel');

            const channels = await loadEncryptedJson();

            const apikey = channels[`${interaction.guild.id}`].erlcApiKey;

            const erlcClient = new ERLCClient({
                serverKey: apikey
            });

            const server = await erlcClient.getServer();

            const joincode = await server.JoinKey ?? server.joinKey;

            const embed = new EmbedBuilder()
                .setTitle('ERLC Session Started')
                .setDescription(`A new ERLC session has been started in ${channel}.`)
                .setColor(0x00FF00)
                .addFields(
                    { name: 'Join Code', value: joincode, inline: true }
                )
                .setTimestamp();

            const message = await channel.send({ embeds: [embed], content: '@everyone' });
            
            message.edit({ embeds: [embed], content: '' });

            } else if (interaction.commandName === 'session-end') {
                await interaction.deferReply({ ephemeral: true });

                const channel = interaction.options.getChannel('channel');

                const messages = await channel.messages.fetch({ limit: 100 });

                const lastEmbedMsg = messages.find((msg) => msg.embeds.length > 0);

                const endembed = new EmbedBuilder()
                    .setTitle('ERLC Session Ended')
                    .setDescription(`The session has ended, please do not join under any circumstances.`)
                    .setColor(0xFF0000)
                    .setTimestamp();

                await lastEmbedMsg.edit({ embeds: [endembed], content: '@everyone'});

                await sleep(2000);

                await lastEmbedMsg.edit({ embeds: [endembed], content: '' });
            } else if (interaction.commandName === 'session-low') {
                await interaction.deferReply({ ephemeral: true });
                
                const channel = interaction.options.getChannel('channel');

                const messages = await channel.messages.fetch({ limit: 100 });

                const lastEmbedMsg = messages.find((msg) => msg.embeds.length > 0);

                const lowembed = new EmbedBuilder()
                    .setTitle('ERLC Session Low Population')
                    .setDescription(`The session is now set to low population, Fill up these spaces!.`)
                    .setColor(0xFFFF00)
                    .setTimestamp();

                await lastEmbedMsg.edit({ embeds: [lowembed], content: '@everyone'});

                await sleep(2000);

                await lastEmbedMsg.edit({ embeds: [lowembed], content: '' });
            } else if (interaction.commandName === 'session-full') {
                await interaction.deferReply({ ephemeral: true });

                const channel = interaction.options.getChannel('channel');

                const messages = await channel.messages.fetch({ limit: 100 });

                const lastEmbedMsg = messages.find((msg) => msg.embeds.length > 0);

                const fullembed = new EmbedBuilder()
                    .setTitle('ERLC Session Full Population')
                    .setDescription(`The session is now set to full population, Unfortunatley there are no more spots left!.`)
                    .setColor(0xFF0000)
                    .setTimestamp();

                await lastEmbedMsg.edit({ embeds: [fullembed], content: '@everyone'});

                await sleep(2000);

                await lastEmbedMsg.edit({ embeds: [fullembed], content: '' });
            }
}
});

client.once(Events.ClientReady, () => console.log(`✅ Logged in as ${client.user.tag}`));
client.login(TOKEN);