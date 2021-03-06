/* eslint-disable @typescript-eslint/ban-types */

export type RecursivePartial<T> = {
    [P in keyof T]?: T[P] extends (infer U)[]
        ? RecursivePartial<U>[]
        : T[P] extends Function
        ? T[P]
        : T[P] extends object
        ? RecursivePartial<T[P]>
        : T[P];
};

export type RecursiveRequired<T> = {
    [P in keyof T]-?: T[P] extends (infer U)[]
        ? RecursiveRequired<U>[]
        : T[P] extends Function
        ? T[P]
        : T[P] extends object | undefined
        ? RecursiveRequired<T[P]>
        : T[P];
};

export interface Constructor<T = unknown> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new (...args: any[]): T;
}

export type Filter<Base, Condition> = {
    [Key in keyof Base]: Base[Key] extends Condition ? Key : never;
};

export type FilterNot<Base, Condition> = {
    [Key in keyof Base]: Base[Key] extends Condition ? never : Key;
};

export type FilterKeys<Base, Condition> = Filter<Base, Condition>[keyof Base];

export type FilterKeysNot<Base, Condition> = FilterNot<Base, Condition>[keyof Base];

export type Condition<T> = (value: T, index: number, obj: T[]) => boolean;

export type DiscriminateUnion<T, K extends keyof T, V extends T[K]> = T extends Record<K, V>
    ? T
    : never;

export type HasFields = Record<string, unknown>;

export type SafeFunction = (...args: unknown[]) => unknown;

export type Require<T, K extends keyof T> = T & Pick<Required<T>, K>;

export type Identifier = number | bigint | string;

export type TypeOfResult =
    | "string"
    | "number"
    | "bigint"
    | "boolean"
    | "symbol"
    | "undefined"
    | "object"
    | "function";

export type TypeOf<T extends TypeOfResult> = T extends "string"
    ? string
    : T extends "number"
    ? number
    : T extends "bigint"
    ? bigint
    : T extends "boolean"
    ? boolean
    : T extends "symbol"
    ? symbol
    : T extends "undefined"
    ? undefined
    : T extends "object"
    ? object
    : T extends "function"
    ? Function
    : never;

// https://stackoverflow.com/a/54178819/10502674
export type PartialBy<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

// https://stackoverflow.com/a/56333836/10502674
export type WidenLiterals<T> = T extends boolean
    ? boolean
    : T extends string
    ? string
    : T extends number
    ? number
    : T;
