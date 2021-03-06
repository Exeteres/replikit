import {
    ChannelInfo,
    AccountInfo,
    Attachment,
    MessageMetadata,
    ForwardedMessage
} from "@replikit/core/typings";

export interface InMessage {
    channel: ChannelInfo;
    account: AccountInfo;
    text?: string;
    attachments: Attachment[];
    reply?: InMessage;
    forwarded: ForwardedMessage[];
    metadata: MessageMetadata;
}
