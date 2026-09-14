import { Router, type IRouter } from "express";
import healthRouter from "./health";
import protocolRouter from "./protocol";

const router: IRouter = Router();

router.use(healthRouter);
router.use(protocolRouter);

export default router;
