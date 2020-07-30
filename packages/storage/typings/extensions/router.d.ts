import "@replikit/router/typings";
import { Channel, User, FallbackStrategy, Member, ConnectionManager } from "@replikit/storage";
import { EntityExtensionConstructor, ApplyExtensions } from "@replikit/storage/typings";

declare module "@replikit/router/typings/context/channelContext" {
    export interface ChannelContext {
        readonly connection: ConnectionManager;
        getChannel(fallbackStrategy?: FallbackStrategy): Promise<Channel>;
    }
}

declare module "@replikit/router/typings/context/accountContext" {
    export interface AccountContext {
        getUser(fallbackStrategy?: FallbackStrategy): Promise<User>;
        getUser<E extends EntityExtensionConstructor[]>(
            fallbackStrategy: FallbackStrategy,
            ...extensions: E
        ): Promise<ApplyExtensions<User, E>>;
        getUser<E extends EntityExtensionConstructor[]>(
            ...extensions: E
        ): Promise<ApplyExtensions<User, E>>;
    }
}

declare module "@replikit/router/typings/context/memberContext" {
    export interface MemberContext {
        getMember(fallbackStrategy?: FallbackStrategy): Promise<Member>;
        getMember<E extends EntityExtensionConstructor[]>(
            fallbackStrategy: FallbackStrategy,
            ...extensions: E
        ): Promise<ApplyExtensions<Member, E>>;
        getMember<E extends EntityExtensionConstructor[]>(
            ...extensions: E
        ): Promise<ApplyExtensions<Member, E>>;
        getChannelMember(channelId: number): Promise<Member | undefined>;
    }
}
