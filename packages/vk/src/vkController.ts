import {
    Controller,
    config,
    AttachmentType,
    TextTokenizer,
    TextTokenKind,
    ChannelType,
    TextFormatter
} from "@replikit/core";
import {
    ChannelInfo,
    ResolvedMessage,
    AccountInfo,
    SendedMessage,
    InMessage,
    Attachment,
    ResolvedAttachment,
    SendedAttachment,
    ForwardedMessage
} from "@replikit/core/typings";
import {
    VK,
    MessageContext,
    PhotoAttachment,
    AudioMessageAttachment,
    StickerAttachment,
    Attachment as VKAttachment,
    ExternalAttachment
} from "vk-io";
import MessageForward from "vk-io/lib/structures/shared/message-forward";
import MessageReply from "vk-io/lib/structures/shared/message-reply";

function createSendedAttachment(
    attachment: ResolvedAttachment
): SendedAttachment {
    return { origin: attachment, id: attachment.source };
}

export class VKController extends Controller {
    private readonly vk: VK;

    constructor() {
        const textTokenizer = new TextTokenizer()
            .addRegexRule(/\[id(\d*)\|(.*)]/, groups => ({
                kind: TextTokenKind.Mention as const,
                id: +groups[1],
                text: groups[2],
                props: []
            }))
            .addRegexRule(/\[club(\d*)\|(.*)]/, groups => ({
                kind: TextTokenKind.Link as const,
                url: `https://vk.com/public${groups[1]}`,
                text: groups[2],
                props: []
            }));

        const textFormatter = new TextFormatter()
            .addVisitor(TextTokenKind.Mention, token => {
                return `[id${token.id}|${token.text}]`;
            })
            .addVisitor(TextTokenKind.Link, token => {
                return `${token.text} (${token.url})`;
            });

        super({
            name: "vk",
            textTokenizer,
            textFormatter
        });

        this.vk = new VK({
            token: config.vk.token,
            pollingGroupId: config.vk.pollingGroup
        });

        this.vk.updates.on("new_message", async context => {
            if (context.senderType === "user") {
                const message = await this.createMessage(context);
                this.processMessageEvent("message:received", message);
            }
        });

        this.vk.updates.on("edit_message", async context => {
            if (context.senderType === "user") {
                const message = await this.createMessage(context);
                this.processMessageEvent("message:edited", message);
            }
        });
    }

    async start(): Promise<void> {
        this._botId = config.vk.pollingGroup;
        await this.vk.updates.start();
    }

    async stop(): Promise<void> {
        await this.vk.updates.stop();
    }

    private createRequest(channelId: number, id: number): string {
        return `
            var resp = API.messages.getByConversationMessageId({ 
                peer_id: ${channelId}, 
                conversation_message_ids: [${id}]  
            });
            if (resp.count == 0) {
                return;
            }
            var messageId = resp.items[0].id;
        `;
    }

    async deleteMessage(channelId: number, id: number): Promise<void> {
        const request = this.createRequest(channelId, id);
        await this.vk.api.execute({
            code: `
                ${request}
                API.messages.delete({
                    delete_for_all: true,
                    message_ids: [messageId]
                });
            `
        });
    }

    protected async fetchChannelInfo(
        localId: number
    ): Promise<ChannelInfo | undefined> {
        const conversations = await this.vk.api.messages.getConversationsById({
            peer_ids: [localId]
        });
        const conversation = conversations.items[0];
        if (!conversation) {
            return undefined;
        }

        const canWrite = conversation.can_write?.allowed;
        if (conversation.peer?.type === "user") {
            const user = await this.getAccountInfo(localId);
            if (!user) {
                return undefined;
            }
            const usernamePostfix = user.username ? ` (${user.username})` : "";
            return {
                id: localId,
                title: `${user.firstName} ${user.lastName}` + usernamePostfix,
                type: ChannelType.Direct,
                permissions: {
                    sendMessages: canWrite,
                    deleteMessages: canWrite,
                    editMessages: canWrite,
                    deleteOtherMessages: false
                }
            };
        }
        const canManage =
            conversation.chat_settings?.owner_id === -config.vk.pollingGroup;
        return {
            id: localId,
            title: conversation.chat_settings?.title,
            type: ChannelType.Group,
            permissions: {
                sendMessages: canWrite,
                editMessages: canManage,
                deleteMessages: canManage,
                deleteOtherMessages: canManage
            }
        };
    }

    protected async uploadAttachment(
        channelId: number,
        attachment: Attachment
    ): Promise<string | undefined> {
        switch (attachment.type) {
            case AttachmentType.Photo:
            case AttachmentType.Sticker: {
                const uploaded = await this.vk.upload.messagePhoto({
                    source: attachment.url!
                });
                return uploaded.toString();
            }
            case AttachmentType.Voice: {
                const uploaded = await this.vk.upload.audioMessage({
                    source: attachment.url!,
                    peer_id: channelId
                });
                return uploaded.toString();
            }
        }
        return undefined;
    }

    protected async fetchAccountInfo(
        localId: number
    ): Promise<AccountInfo | undefined> {
        if (localId > 0) {
            const users = await this.vk.api.users.get({
                user_ids: [localId.toString()],
                fields: ["screen_name", "photo_100"]
            });
            const user = users[0];
            if (!user) {
                return undefined;
            }
            return {
                id: localId,
                username: user.screen_name,
                firstName: user.first_name,
                lastName: user.last_name,
                avatarUrl: user.photo_100?.toString()
            };
        }

        const groups = await this.vk.api.groups.getById({
            group_id: localId.toString()
        });
        const group = groups[0];
        if (!group) {
            return undefined;
        }
        return {
            id: localId,
            username: group.screen_name,
            firstName: group.name
        };
    }

    protected async sendResolvedMessage(
        channelId: number,
        message: ResolvedMessage
    ): Promise<SendedMessage | undefined> {
        let result: SendedMessage | undefined;

        const attachments = message.attachments.filter(
            x =>
                x.type !== AttachmentType.Sticker ||
                x.controllerName !== this.name
        );

        if (attachments.length || message.text) {
            const sended = await this.vk.api.messages.send({
                peer_id: channelId,
                message: message.text ?? "",
                attachment: attachments.map(x => x.source).join(", ")
            });
            result = this.createSendedMessage(sended, attachments);
        }

        const sticker = message.attachments.find(
            x => x.type === AttachmentType.Sticker
        );
        if (sticker && sticker.controllerName === this.name) {
            const sended = await this.vk.api.messages.send({
                peer_id: channelId,
                sticker_id: parseInt(sticker.id)
            });
            if (!result) {
                result = this.createSendedMessage(sended, [sticker]);
            } else {
                result.attachments.push(createSendedAttachment(sticker));
            }
        }

        return result;
    }

    private createSendedMessage(
        id: number,
        attachments: ResolvedAttachment[]
    ): SendedMessage {
        return {
            id,
            attachments: attachments.map(createSendedAttachment),
            metadata: { firstAttachment: false, messageIds: [id] }
        };
    }

    protected async editResolvedMessage(
        channelId: number,
        message: ResolvedMessage
    ): Promise<SendedMessage> {
        const messageId = message.metadata.messageIds[0];
        const request = this.createRequest(channelId, messageId);
        await this.vk.api.execute({
            code: `
                ${request}
                API.messages.edit({
                    peer_id: ${channelId},
                    message_id: messageId,
                    message: ${JSON.stringify(message.text)},
                    attachment: "${message.attachments
                        .map(x => x.source)
                        .join(", ")}"
                });
            `
        });

        return {
            attachments: [],
            id: messageId,
            metadata: { firstAttachment: false, messageIds: [messageId] }
        };
    }

    private createChannel(channelId: number): ChannelInfo {
        return {
            id: channelId,
            type: ChannelType.Unknown,
            permissions: {
                deleteMessages: false,
                editMessages: false,
                sendMessages: false,
                deleteOtherMessages: false
            }
        };
    }

    private createAccount(accountId: number): AccountInfo {
        return { id: accountId };
    }

    private async resolveChannel(channelId: number): Promise<ChannelInfo> {
        const channel = await this.getChannelInfo(channelId);
        return channel ?? this.createChannel(channelId);
    }

    private async resolveAccount(accountId: number): Promise<AccountInfo> {
        const account = await this.getAccountInfo(accountId);
        return account ?? this.createAccount(accountId);
    }

    private extractAttachments(
        attachments: (VKAttachment<unknown> | ExternalAttachment<unknown>)[]
    ): Attachment[] {
        const result: Attachment[] = [];
        for (const attachment of attachments) {
            switch (attachment.type) {
                case "photo": {
                    const photoAttachment = attachment as PhotoAttachment;
                    result.push({
                        type: AttachmentType.Photo,
                        id: photoAttachment.toString(),
                        url: photoAttachment.largePhoto!
                    });
                    break;
                }
                case "audio_message": {
                    const voiceAttachment = attachment as AudioMessageAttachment;
                    result.push({
                        type: AttachmentType.Voice,
                        id: voiceAttachment.toString(),
                        url: voiceAttachment.oggUrl!
                    });
                    break;
                }
                case "sticker": {
                    const stickerAttachment = attachment as StickerAttachment;
                    const images = stickerAttachment.images;
                    result.push({
                        type: AttachmentType.Sticker,
                        id: stickerAttachment.id.toString(),
                        url: images[images.length - 3].url
                    });
                    break;
                }
            }
        }
        return result;
    }

    private createForwardedMessage(message: MessageForward): ForwardedMessage {
        return {
            id: -1,
            text: message.text ?? undefined,
            controllerName: this.name,
            attachments: this.extractAttachments(message.attachments),
            channel: this.createChannel(-1),
            account: this.createAccount(message.senderId),
            forwarded: message.forwards.map(x =>
                this.createForwardedMessage(x)
            ),
            metadata: { firstAttachment: false, messageIds: [-1] }
        };
    }

    private async createReplyMessage(
        channel: ChannelInfo,
        replyMessage: MessageReply | null
    ): Promise<InMessage | undefined> {
        if (!replyMessage) {
            return;
        }
        return {
            id: replyMessage.conversationMessageId!,
            text: replyMessage.text!,
            attachments: this.extractAttachments(replyMessage.attachments),
            channel,
            account: await this.resolveAccount(replyMessage.senderId),
            forwarded: [],
            metadata: {
                firstAttachment: false,
                messageIds: [replyMessage.conversationMessageId!]
            }
        };
    }

    private async createMessage(
        context: MessageContext<Record<string, unknown>>
    ): Promise<InMessage> {
        const channel = await this.resolveChannel(context.peerId);
        return {
            id: context.id || context.conversationMessageId!,
            text: context.text ?? undefined,
            attachments: this.extractAttachments(context.attachments),
            channel,
            account: await this.resolveAccount(context.senderId),
            forwarded: context.forwards.flatten.map(x =>
                this.createForwardedMessage(x)
            ),
            reply: await this.createReplyMessage(channel, context.replyMessage),
            metadata: {
                firstAttachment: false,
                messageIds: [context.id || context.conversationMessageId!]
            }
        };
    }
}
