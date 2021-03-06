import { TextTokenKind } from "@replikit/core";

export class TextTokenVisitorNotFoundError extends Error {
    constructor(kind: TextTokenKind) {
        super(`TokenVisitor for kind ${kind} not found`);
    }
}

export class MissingMetadataError extends Error {
    constructor() {
        super("Missing message metadata");
    }
}

export class EmptyContentError extends Error {
    constructor() {
        super("Empty content");
    }
}

export class ModuleNotFoundError extends Error {
    constructor(module: string, requirer: string) {
        super(`Module ${module} not found, but is required by ${requirer}`);
    }
}
