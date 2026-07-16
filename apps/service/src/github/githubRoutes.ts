import type { Express, Request, Response } from "express";
import type { GithubService } from "./githubService.js";

export function mountGithubRoutes(app: Express, github: GithubService): void {
  app.get("/api/github/accounts", async (_request: Request, response: Response) => {
    try {
      response.json(await github.listAccounts());
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "无法列出 GitHub 帐号。" });
    }
  });

  app.post("/api/github/accounts", async (request: Request, response: Response) => {
    try {
      const token = typeof request.body?.token === "string" ? request.body.token : "";
      const account = await github.addAccount(token);
      response.status(201).json(account);
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "无法关联 GitHub。" });
    }
  });

  app.delete("/api/github/accounts/:accountId", async (request: Request, response: Response) => {
    try {
      const accountId = String(request.params.accountId ?? "");
      await github.removeAccount(accountId);
      response.status(204).end();
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "无法移除帐号。" });
    }
  });

  app.get("/api/github/accounts/:accountId/repos", async (request: Request, response: Response) => {
    try {
      const accountId = String(request.params.accountId ?? "");
      const q = typeof request.query.q === "string" ? request.query.q : undefined;
      response.json(await github.listRepos(accountId, q));
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "无法列出仓库。" });
    }
  });

  app.post("/api/github/projects", async (request: Request, response: Response) => {
    try {
      const project = await github.createProjectFromRepo({
        accountId: typeof request.body?.accountId === "string" ? request.body.accountId : "",
        fullName: typeof request.body?.fullName === "string" ? request.body.fullName : "",
        name: typeof request.body?.name === "string" ? request.body.name : undefined,
        localPath: typeof request.body?.localPath === "string" ? request.body.localPath : undefined,
        clone: request.body?.clone === false ? false : true
      });
      response.status(201).json(project);
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "无法从 GitHub 创建项目。" });
    }
  });
}
