declare module "turndown" {
  export default class TurndownService {
    turndown(input: string): string
    remove(filter: string | string[]): this
    addRule(
      key: string,
      rule: {
        filter: (node: HTMLElement) => boolean
        replacement: (content: string, node: HTMLElement) => string
      },
    ): this
  }
}
