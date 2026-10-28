export declare const SKILL_COMMANDS: Record<string, [string, string]>;
export declare const SAFE_SKILL_COMMANDS: string[];
export declare function skillCommand(root: string, key: string): string;
export declare function expandSkillTemplate(text: string, root: string): string;
