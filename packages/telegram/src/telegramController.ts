import {
    ChannelInfo,
    AccountInfo,
    InMessage,
    Attachment,
    ResolvedAttachment,
    SendedMessage,
    ResolvedMessage,
    TextToken,
    MessageEventName,
    ChannelPermissionMap,
    SendedAttachment,
    MessageMetadata,
    InlineQuery as CoreInlineQuery,
    ChosenInlineQueryResult,
    InlineQueryResponse,
    InlineQueryResult as CoreInlineQueryResult,
    Button,
    HasFields
} from "@replikit/core/typings";
import Telegraf, { Markup } from "telegraf";
import {
    config,
    Controller,
    AttachmentType,
    chunk,
    ChannelType,
    groupBy,
    CacheManager,
    TextFormatter,
    TextTokenKind,
    TextTokenProp,
    assertType,
    assert
} from "@replikit/core";
import {
    Chat,
    User,
    Message,
    File,
    Update,
    IncomingMessage,
    PhotoSize,
    InlineQuery,
    ChosenInlineResult,
    InlineQueryResult,
    InlineKeyboardMarkup
} from "telegraf/typings/telegram-types";
import { TelegrafContext } from "telegraf/typings/context";
import { logger, MessageTokenizer, escapeHtml } from "@replikit/telegram";
import { Dice } from "@replikit/telegram/typings";
import { InlineKeyboardButton } from "telegraf/typings/markup";

export class TelegramController extends Controller {
    readonly backend: Telegraf<TelegrafContext>;

    private startDate: number;
    private readonly permissionCache: CacheManager<number, ChannelPermissionMap>;
    private readonly chatCache: CacheManager<number | string, Chat | undefined>;
    private readonly avatarUrlCache: CacheManager<number, Attachment | undefined>;

    constructor() {
        const textFormatter = new TextFormatter()
            .addPropFormatter(TextTokenProp.Bold, "<b>", "</b>")
            .addPropFormatter(TextTokenProp.Italic, "<i>", "</i>")
            .addPropFormatter(TextTokenProp.Underline, "<u>", "</u>")
            .addPropFormatter(TextTokenProp.Strikethrough, "<s>", "</s>")
            .addPropFormatter(TextTokenProp.Code, "<pre>", "</pre>")
            .addPropFormatter(TextTokenProp.InlineCode, "<code>", "</code>")
            .addVisitor(TextTokenKind.Text, token => {
                return escapeHtml(token.text);
            })
            .addVisitor(TextTokenKind.Link, token => {
                return `<a href="${token.url}">${escapeHtml(token.text)}</a>`;
            })
            .addVisitor(TextTokenKind.Mention, token => {
                const text = escapeHtml(token.text ?? token.username ?? "");
                return `<a href="tg://user?id=${token.id}">${text}</a>`;
            });

        super({
            name: "tg",
            features: { implicitUpload: true, inlineMode: true, inlineButtons: true },
            textFormatter
        });

        assert(config.telegram.token, "Missing telegram token");

        this.backend = new Telegraf(config.telegram.token);
        this.backend.handleUpdates = this.handleUpdates.bind(this);

        this.permissionCache = new CacheManager(
            this.fetchChannelPermissions.bind(this),
            config.core.cache.expire
        );

        this.chatCache = new CacheManager(
            this.backend.telegram.getChat.bind(this.backend.telegram),
            config.core.cache.expire
        );

        this.avatarUrlCache = new CacheManager(this.getAvatar.bind(this), config.core.cache.expire);
    }

    private async getAvatar(userId: number): Promise<Attachment | undefined> {
        interface UserProfilePhotos {
            photos: PhotoSize[][];
        }

        interface Telegram {
            getUserProfilePhotos(userId: number): Promise<UserProfilePhotos>;
        }

        try {
            const { photos } = await ((this.backend
                .telegram as unknown) as Telegram).getUserProfilePhotos(userId);
            if (!photos.length) {
                return;
            }
            const photo = photos[0];
            const file = await this.backend.telegram.getFile(photo[photo.length - 1].file_id);
            return this.getAttachment(AttachmentType.Photo, file.file_id);
        } catch (err) {
            logger.warn("Error while getting avatar url", err);
            return;
        }
    }

    private async handleMediaGroup(event: MessageEventName, messages: Message[]): Promise<void> {
        const primary = messages[0];
        const message = await this.createMessage(primary);
        for (const mediaItem of messages.slice(1)) {
            const attachment = await this.resolveAttachment(mediaItem);
            if (attachment) {
                if (message.forwarded.length) {
                    message.forwarded[0].attachments.push(attachment);
                } else {
                    message.attachments.push(attachment);
                }
            }
        }
        this.processMessageEvent(event, message);
    }

    private async handleUpdate(message: Message): Promise<boolean> {
        if (message.new_chat_members) {
            const channel = await this.createChannel(message.chat);
            for (const member of message.new_chat_members) {
                const account = await this.createAccount(member);
                this.processEvent("member:joined", { channel, account });
            }
            return true;
        }

        if (message.left_chat_member) {
            const channel = await this.createChannel(message.chat);
            const account = await this.createAccount(message.left_chat_member);
            this.processEvent("member:left", { channel, account });
            return true;
        }

        if (message.new_chat_title) {
            const channel = await this.createChannel(message.chat);
            this.processEvent("channel:title:edited", { channel });
            return true;
        }

        if (message.new_chat_photo) {
            const channel = await this.createChannel(message.chat);
            const photo = this.createPhotoAttachment(message.new_chat_photo);
            this.processEvent("channel:photo:edited", { channel, photo });
            return true;
        }

        if (message.delete_chat_photo) {
            const channel = await this.createChannel(message.chat);
            this.processEvent("channel:photo:deleted", { channel });
            return true;
        }

        return false;
    }

    private async handleMessages(event: MessageEventName, messages: Message[]): Promise<void> {
        const mediaGroups = groupBy(messages, "media_group_id");
        for (const group of mediaGroups) {
            if (group.key !== "undefined") {
                await this.handleMediaGroup(event, group.value);
                continue;
            }
            for (const message of group.value) {
                await this.handleMediaGroup(event, [message]);
            }
        }
    }

    private async handleUpdates(updates: Update[]): Promise<unknown[]> {
        const receivedMessages: Message[] = [];
        const editedMessages: Message[] = [];
        for (const update of updates) {
            if (update.message) {
                if (update.message.date < this.startDate) {
                    continue;
                }
                const handled = await this.handleUpdate(update.message);
                if (!handled) {
                    receivedMessages.push(update.message);
                }
                continue;
            }

            if (update.edited_message) {
                if (update.edited_message.edit_date! < this.startDate) {
                    continue;
                }
                editedMessages.push(update.edited_message);
                continue;
            }

            if (update.inline_query) {
                const account = await this.createAccount(update.inline_query.from);
                const query = this.createInlineQuery(update.inline_query);
                this.processEvent("inline-query:received", { account, query });
                continue;
            }

            if (update.chosen_inline_result) {
                const account = await this.createAccount(update.chosen_inline_result.from);
                const result = this.createChosenInlineQueryResult(update.chosen_inline_result);
                this.processEvent("inline-query:chosen", { account, result });
                continue;
            }

            if (update.callback_query) {
                const buttonMessage = update.callback_query.message;
                assert(buttonMessage, "Unable to process button click without access to message");
                const account = await this.createAccount(update.callback_query.from);
                const message = await this.createMessage(buttonMessage);
                const buttonPayload = update.callback_query.data;
                this.processMessageLikeEvent("button:clicked", {
                    message,
                    account,
                    buttonPayload: buttonPayload as string
                });
                continue;
            }

            await this.backend.handleUpdate(update);
        }
        await this.handleMessages("message:received", receivedMessages);
        await this.handleMessages("message:edited", editedMessages);
        return undefined!;
    }

    async answerInlineQuery(id: string, response: InlineQueryResponse): Promise<void> {
        await this.backend.telegram.answerInlineQuery(
            id,
            // eslint-disable-next-line @typescript-eslint/unbound-method
            response.results.map(this.createInlineQueryResult),
            {
                cache_time: response.cacheTime,
                is_personal: response.isPersonal,
                next_offset: response.nextOffset,
                switch_pm_text: response.switchPMText,
                switch_pm_parameter: response.switchPMParameter
            }
        );
    }

    private createInlineQueryResult(result: CoreInlineQueryResult): InlineQueryResult {
        if ("article" in result) {
            return {
                id: result.id,
                type: "article",
                title: result.article.title,
                description: result.article.description,
                input_message_content: {
                    message_text: result.message?.text ?? result.article.title
                }
            };
        }
        const { attachment, id, message } = result;
        const commonFields = {
            id,
            input_message_content: message?.text ? { message_text: message.text } : undefined
        };
        const title = attachment.title ?? "Untitled";
        switch (attachment.type) {
            case AttachmentType.Sticker: {
                return {
                    ...commonFields,
                    type: "sticker",
                    sticker_file_id: attachment.id
                };
            }
            case AttachmentType.Photo: {
                return {
                    ...commonFields,
                    type: "photo",
                    photo_file_id: attachment.id
                };
            }
            case AttachmentType.Video: {
                return {
                    ...commonFields,
                    title,
                    type: "video",
                    video_file_id: attachment.id
                };
            }
            case AttachmentType.Document: {
                return {
                    ...commonFields,
                    title,
                    type: "document",
                    document_file_id: attachment.id
                };
            }
            case AttachmentType.Voice: {
                return {
                    ...commonFields,
                    title,
                    type: "voice",
                    document_file_id: attachment.id
                };
            }
            case AttachmentType.Animation: {
                return {
                    ...commonFields,
                    title,
                    type: "mpeg4_gif",
                    document_file_id: attachment.id
                };
            }
        }
        // throw new Error(`Attachment with type ${attachment.type} cannot be an inline query result`);
    }

    private async fetchChannelPermissions(channelId: number): Promise<ChannelPermissionMap> {
        const botMember = await this.backend.telegram.getChatMember(channelId, this.botInfo.id);
        if (!botMember) {
            return {
                deleteMessages: false,
                deleteOtherMessages: false,
                editMessages: false,
                sendMessages: false
            };
        }
        return {
            sendMessages: botMember.can_send_messages ?? false,
            deleteMessages: true,
            editMessages: true,
            deleteOtherMessages: botMember.can_delete_messages ?? false
        };
    }

    tokenizeText(message: InMessage): TextToken[] {
        if (!message.text || !message.telegram) {
            return [];
        }
        const tokenizer = new MessageTokenizer(message.text, message.telegram?.entities ?? []);
        return tokenizer.tokenize();
    }

    async start(): Promise<void> {
        this.startDate = Math.floor(Date.now() / 1000);
        const me = await this.backend.telegram.getMe();
        this._botInfo = { id: me.id, username: me.username! };
        await this.backend.launch();
    }

    async stop(): Promise<void> {
        await this.backend.stop();
    }

    protected async fetchChannelInfo(localId: number): Promise<ChannelInfo | undefined> {
        try {
            const chat = await this.chatCache.get(localId);
            return chat && this.createChannel(chat);
        } catch {
            return undefined;
        }
    }

    protected async fetchAccountInfo(localId: number): Promise<AccountInfo | undefined> {
        try {
            const chat = await this.chatCache.get(localId);
            return chat && (await this.createAccount(chat));
        } catch {
            return undefined;
        }
    }

    private createButtons(buttons: Button[][]): InlineKeyboardMarkup | undefined {
        if (!buttons.length) {
            return;
        }
        const payload = buttons.map(x => {
            return x.map(y => {
                const result = {
                    callback_data: y.payload,
                    text: y.text,
                    url: y.url
                } as HasFields;
                if (y.switchInline) {
                    const key = y.switchInline.current
                        ? "switch_inline_query_current_chat"
                        : "switch_inline_query";
                    result[key] = y.switchInline.username ?? "";
                }
                return result;
            });
        });
        return Markup.inlineKeyboard((payload as unknown) as InlineKeyboardButton[]);
    }

    async sendResolvedMessage(channelId: number, message: ResolvedMessage): Promise<SendedMessage> {
        let result: SendedMessage | undefined = undefined;

        let extra = this.createExtra(message);

        // Отправляем текст, если есть
        if (message.text) {
            const sended = await this.backend.telegram.sendMessage(channelId, message.text, extra);
            extra = undefined;
            result = await this.createSendedMessage(sended);
        }

        // Сортируем вложения по типу
        const attachments = this.sortAttachments(message.attachments);

        // Отправляем фото и видео
        const media = attachments.filter(
            x => x.type === AttachmentType.Photo || x.type === AttachmentType.Video
        );

        if (media.length === 1) {
            // Отправляем один элемент
            const item = media[0];

            const sended = await (item.type === AttachmentType.Photo
                ? this.backend.telegram.sendPhoto(channelId, item.source, extra)
                : this.backend.telegram.sendVideo(channelId, item.source, extra));
            extra = undefined;
            if (!result) {
                result = await this.createSendedMessage(sended);
            }
        } else if (media.length) {
            // Отправляем медиа группу (или несколько групп)
            const mediaGroups = chunk(media, 10);
            for (const mediaGroup of mediaGroups) {
                const items = mediaGroup.map(x => ({
                    type: x.type === AttachmentType.Photo ? "photo" : "video",
                    media: x.source
                }));
                const sended = await this.backend.telegram.sendMediaGroup(channelId, items, extra);
                extra = undefined;
                for (const [i, msg] of sended.entries()) {
                    if (i === 0 && !result) {
                        result = await this.createSendedMessage(msg);
                        continue;
                    }
                    result!.metadata.messageIds.push(msg.message_id);
                    const sendedAttachment = await this.createSendedAttachment(msg, mediaGroup[i]);
                    result?.attachments.push(sendedAttachment);
                }
            }
        }

        // Отправляем прочие вложения
        const otherAttachments = attachments.filter(x => !media.includes(x));
        for (const [i, attachment] of otherAttachments.entries()) {
            const sended = await this.sendOtherAttachment(channelId, attachment, extra);
            extra = undefined;
            if (i === 0 && !result) {
                result = await this.createSendedMessage(sended);
                continue;
            }
            result!.metadata.messageIds.push(sended.message_id);
            const sendedAttachment = await this.createSendedAttachment(sended, attachment);
            result!.attachments.push(sendedAttachment);
        }

        // Отправляем пересланные сообщения
        for (const [i, forwarded] of message.forwarded.entries()) {
            assertType(forwarded.channelId, "number", "forwarded channel id");
            assertType(forwarded.messageId, "number", "forwarded message id");
            const sended = await this.backend.telegram.forwardMessage(
                channelId,
                forwarded.channelId,
                forwarded.messageId
            );
            if (i === 0 && !result) {
                result = await this.createSendedMessage(sended);
                continue;
            }
            result!.metadata.messageIds.push(sended.message_id);
        }

        if (!result) {
            throw new Error("Empty content");
        }

        return result;
    }

    private createExtra(message: ResolvedMessage): Record<string, unknown> | undefined {
        return {
            reply_to_message_id: message.reply?.messageIds[0],
            parse_mode: "HTML",
            disable_web_page_preview: true,
            reply_markup: this.createButtons(message.buttons)
        };
    }

    private sendOtherAttachment(
        channelId: number,
        attachment: ResolvedAttachment,
        extra: Record<string, unknown> | undefined
    ): Promise<Message> {
        switch (attachment.type) {
            case AttachmentType.Sticker: {
                if (attachment.controllerName === this.name) {
                    return this.backend.telegram.sendSticker(channelId, attachment.source, extra);
                }
                return this.backend.telegram.sendPhoto(channelId, attachment.source, extra);
            }
            case AttachmentType.Voice: {
                return this.backend.telegram.sendVoice(channelId, attachment.source, extra);
            }
            case AttachmentType.Document: {
                return this.backend.telegram.sendDocument(channelId, attachment.source, extra);
            }
            case AttachmentType.Animation: {
                return this.backend.telegram.sendAnimation(channelId, attachment.source, extra);
            }
            case AttachmentType.Video: {
                return this.backend.telegram.sendVideo(channelId, attachment.source, extra);
            }
            default: {
                const type = AttachmentType[attachment.type];
                return this.backend.telegram.sendMessage(
                    channelId,
                    `<code>Unsupported attachment type: "${type}"</code>`,
                    { parse_mode: "HTML", ...extra }
                );
            }
        }
    }

    protected async editResolvedMessage(
        channelId: number,
        message: ResolvedMessage
    ): Promise<SendedMessage | undefined> {
        let result: SendedMessage | undefined = undefined;
        let extra = this.createExtra(message);

        if (!message.metadata) {
            throw new Error("Metadata required");
        }

        const length =
            message.attachments.length + message.forwarded.length + (message.text ? 1 : 0);
        if (length !== message.metadata.messageIds.length) {
            throw new Error("Metadata messageIds length mismatch");
        }

        // Редактируем текст
        if (message.text) {
            if (!message.metadata.hasText) {
                throw new Error("Unable to update text");
            }
            const messageId = message.metadata.messageIds[0];
            assertType(messageId, "number", "message id");
            const edited = await this.backend.telegram.editMessageText(
                channelId,
                messageId,
                undefined,
                message.text,
                extra
            );
            result = await this.createSendedMessage(edited as Message);
            extra = undefined;
        }

        return result;
    }

    async deleteMessage(channelId: number, metadata: MessageMetadata): Promise<void> {
        for (const messageId of metadata.messageIds) {
            assertType(messageId, "number", "message id");
            await this.backend.telegram.deleteMessage(channelId, messageId);
        }
    }

    private async createAccount(user: User | Chat): Promise<AccountInfo> {
        return {
            id: user.id,
            username: user.username,
            firstName: user.first_name,
            lastName: user.last_name,
            language: (user as User).language_code,
            avatar: "type" in user ? undefined : await this.avatarUrlCache.get(user.id)
        };
    }

    private extractTitle(chat: Chat | User): string {
        return (
            (chat as Chat).title ??
            chat.username ??
            (chat.last_name ? `${chat.first_name} ${chat.last_name}` : chat.first_name!)
        );
    }

    private extractAttachment(message: IncomingMessage): Attachment | undefined {
        if (message.photo) {
            return this.createPhotoAttachment(message.photo);
        }

        if (message.sticker) {
            return {
                id: message.sticker.file_id,
                type: AttachmentType.Sticker
            };
        }

        if (message.voice) {
            return { id: message.voice.file_id, type: AttachmentType.Voice };
        }

        if (message.document) {
            return {
                id: message.document.file_id,
                type: AttachmentType.Document
            };
        }

        if (message.video) {
            return { id: message.video.file_id, type: AttachmentType.Video };
        }

        if (message.animation) {
            return {
                id: message.animation.file_id,
                type: AttachmentType.Animation
            };
        }

        return undefined;
    }

    private createPhotoAttachment(photo: PhotoSize[]): Attachment {
        const lastIndex = photo.length - 1;
        return {
            id: photo[lastIndex].file_id,
            type: AttachmentType.Photo
        };
    }

    private getFileUrl(path: string): string {
        return `https://api.telegram.org/file/bot${config.telegram.token}/${path}`;
    }

    private async getAttachment(type: AttachmentType, id: string): Promise<Attachment | undefined> {
        interface AttachmentFile extends File {
            file_unique_id: string;
        }

        try {
            const fileInfo = await this.backend.telegram.getFile(id);
            return {
                type,
                id: (fileInfo as AttachmentFile).file_unique_id,
                url: this.getFileUrl(fileInfo.file_path!),
                uploadId: id
            };
        } catch (e) {
            logger.warn(`Skipping file because of error while getting global id: ${e.message}`);
        }
    }

    private async resolveAttachment(message: Message): Promise<Attachment | undefined> {
        const attachment = this.extractAttachment(message);
        return attachment && this.getAttachment(attachment.type, attachment.id);
    }

    private async extractAttachments(message: Message): Promise<Attachment[]> {
        const attachment = await this.resolveAttachment(message);
        return attachment ? [attachment] : [];
    }

    private async createChannel(chat: Chat | User): Promise<ChannelInfo> {
        if (this.isChat(chat)) {
            const permissions = await this.permissionCache.get(chat.id);
            return {
                id: chat.id,
                title: this.extractTitle(chat),
                type: this.resolveChatType(chat.type),
                permissions
            };
        }
        return {
            id: chat.id,
            title: this.extractTitle(chat),
            type: ChannelType.Direct,
            permissions: {
                deleteMessages: true,
                deleteOtherMessages: true,
                editMessages: true,
                sendMessages: true
            }
        };
    }

    private resolveChatType(type: string): ChannelType {
        switch (type) {
            case "private":
                return ChannelType.Direct;
            case "group":
            case "supergroup":
                return ChannelType.Group;
            case "channel":
                return ChannelType.PostChannel;
        }
        throw new Error("Unexpected channel type");
    }

    private isChat(chat: Chat | User): chat is Chat {
        return "type" in chat;
    }

    private async createSendedAttachment(
        message: Message,
        origin: ResolvedAttachment
    ): Promise<SendedAttachment> {
        const attachment = await this.resolveAttachment(message);
        return { id: attachment!.id, uploadId: attachment!.uploadId, origin };
    }

    private async createSendedMessage(
        message: Message,
        origin?: ResolvedAttachment
    ): Promise<SendedMessage> {
        return {
            attachments: origin ? [await this.createSendedAttachment(message, origin)] : [],
            metadata: {
                messageIds: [message.message_id],
                hasText: !!message.text
            }
        };
    }

    private createMetadata(id: number, hasText: boolean): MessageMetadata {
        return { messageIds: [id], hasText };
    }

    private async createMessage(message: IncomingMessage): Promise<InMessage> {
        if (message.forward_from) {
            return {
                attachments: [],
                account: await this.createAccount(message.from!),
                channel: await this.createChannel(message.chat),
                forwarded: [
                    {
                        text: message.text || message.caption,
                        controllerName: this.name,
                        attachments: await this.extractAttachments(message),
                        account: await this.createAccount(message.forward_from),
                        channel: await this.createChannel(
                            message.forward_from_chat ?? message.forward_from
                        ),
                        forwarded: [],
                        telegram: {
                            entities: message.entities ?? message.caption_entities,
                            dice: message.dice as Dice
                        },
                        metadata: this.createMetadata(
                            message.forward_from_message_id!,
                            !!message.text
                        )
                    }
                ],
                metadata: this.createMetadata(message.message_id, !!message.text)
            };
        }

        if (message.forward_from_chat) {
            return {
                attachments: [],
                account: await this.createAccount(message.from!),
                channel: await this.createChannel(message.chat),
                forwarded: [
                    {
                        text: message.text || message.caption,
                        controllerName: this.name,
                        attachments: await this.extractAttachments(message),
                        account: await this.createAccount(message.forward_from_chat),
                        channel: await this.createChannel(message.forward_from_chat),
                        forwarded: [],
                        telegram: {
                            entities: message.entities ?? message.caption_entities,
                            dice: message.dice as Dice
                        },
                        metadata: this.createMetadata(
                            message.forward_from_message_id!,
                            !!message.text
                        )
                    }
                ],
                metadata: this.createMetadata(message.message_id, !!message.text)
            };
        }

        return {
            text: message.text || message.caption,
            telegram: {
                entities: message.entities ?? message.caption_entities,
                dice: message.dice as Dice
            },
            attachments: await this.extractAttachments(message),
            account: await this.createAccount(message.from!),
            channel: await this.createChannel(message.chat),
            metadata: this.createMetadata(message.message_id, !!message.text),
            reply: message.reply_to_message
                ? await this.createMessage(message.reply_to_message)
                : undefined,
            forwarded: []
        };
    }

    private createChosenInlineQueryResult(result: ChosenInlineResult): ChosenInlineQueryResult {
        return {
            id: result.result_id,
            query: result.query
        };
    }

    private createInlineQuery(query: InlineQuery): CoreInlineQuery {
        return {
            id: query.id,
            offset: query.offset,
            text: query.query
        };
    }

    private sortAttachments(attachments: ResolvedAttachment[]): ResolvedAttachment[] {
        return attachments.sort((a, b) => a.type - b.type);
    }
}
