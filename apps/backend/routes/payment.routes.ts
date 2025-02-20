import express from "express";
import { authMiddleware } from "../middleware";
import { PlanType } from "@prisma/client";
import { prismaClient } from "db";
import Stripe from "stripe";
import {
  createStripeSession,
  createRazorpayOrder,
  verifyStripePayment,
  getStripeSession,
  verifyRazorpaySignature,
  createSubscriptionRecord,
  PaymentService,
} from "../services/payment";

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2025-01-27.acacia",
});

router.post(
  "/create",
  authMiddleware,
  async (req: express.Request, res: express.Response) => {
    try {
      const { plan, isAnnual, method } = req.body;
      const userId = req.userId;
      const userEmail = (req as any).user?.email;

      console.log("Payment request received:", {
        userId,
        plan,
        isAnnual,
        method,
        headers: req.headers,
        body: req.body,
      });

      if (!userId) {
        res.status(401).json({ message: "Unauthorized" });
        return;
      }

      if (!userEmail) {
        res.status(400).json({ message: "User email is required" });
        return;
      }

      if (!plan || !method) {
        res.status(400).json({ message: "Missing required fields" });
        return;
      }

      if (method === "stripe") {
        try {
          const session = await createStripeSession(
            userId,
            plan as "basic" | "premium",
            isAnnual,
            userEmail
          );
          console.log("Stripe session created:", session);
          res.json({ sessionId: session.id });
          return;
        } catch (error) {
          console.error("Stripe session creation error:", error);
          res.status(500).json({
            message: "Error creating payment session",
            details:
              process.env.NODE_ENV === "development"
                ? (error as Error).message
                : undefined,
          });
          return;
        }
      }

      if (method === "razorpay") {
        try {
          const order = await createRazorpayOrder(
            userId,
            plan as "basic" | "premium",
            isAnnual
          );
          
          console.log("Razorpay order created successfully:", order);
          
          res.json({
            ...order,
            handler: function (response: any) {
              console.log("Payment successful:", response);
            },
          });
          return;
        } catch (error) {
          console.error("Razorpay error:", error);
          res.status(500).json({
            message: "Error creating Razorpay order",
            details: process.env.NODE_ENV === "development" 
              ? (error as Error).message 
              : "Payment service temporarily unavailable"
          });
          return;
        }
      }

      res.status(400).json({ message: "Invalid payment method" });
      return;
    } catch (error) {
      console.error("Payment creation error:", error);
      res.status(500).json({
        message: "Error creating payment session",
        details: error instanceof Error ? error.message : "Unknown error",
      });
      return;
    }
  }
);

router.post(
  "/stripe/verify",
  authMiddleware,
  async (req: express.Request, res: express.Response) => {
    try {
      const { sessionId } = req.body;
      if (!sessionId) {
        res.status(400).json({ message: "Session ID is required" });
        return;
      }

      console.log("Verifying session:", sessionId);

      // Get the session with expanded payment_intent
      const session = await stripe.checkout.sessions.retrieve(sessionId, {
        expand: ["payment_intent", "subscription"],
      });

      console.log("Session status:", session.payment_status);
      console.log("Session metadata:", session.metadata);

      // Check if payment is successful
      if (session.payment_status !== "paid") {
        res.status(400).json({
          success: false,
          message: "Payment not completed",
        });
        return;
      }

      const userId = session.metadata?.userId;
      const plan = session.metadata?.plan as PlanType;

      if (!userId || !plan) {
        res.status(400).json({
          success: false,
          message: "Missing user or plan information",
        });
        return;
      }

      // Get payment intent ID
      const paymentIntentId =
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : session.payment_intent?.id;

      if (!paymentIntentId) {
        res.status(400).json({
          success: false,
          message: "Missing payment information",
        });
        return;
      }

      // Create subscription and add credits
      await createSubscriptionRecord(userId, plan, paymentIntentId, sessionId);

      res.json({ success: true });
      return;
    } catch (error) {
      console.error("Stripe verification error:", error);
      res.status(500).json({
        success: false,
        message: error instanceof Error ? error.message : "Unknown error",
      });
      return;
    }
  }
);

router.post(
  "/razorpay/verify",
  authMiddleware,
  async (req: express.Request, res: express.Response) => {
    try {
      if (!req.userId) {
        res.status(401).json({ message: "Unauthorized" });
        return;
      }

      const {
        razorpay_payment_id,
        razorpay_order_id,
        razorpay_signature,
        plan,
      } = req.body;

      if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
        res.status(400).json({ message: "Missing required fields" });
        return;
      }

      if (!Object.values(PlanType).includes(plan)) {
        res.status(400).json({ message: "Invalid plan type" });
        return;
      }

      const isValid = verifyRazorpaySignature(
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature
      );

      if (!isValid) {
        res.status(400).json({ success: false });
        return;
      }

      await createSubscriptionRecord(
        req.userId,
        plan,
        razorpay_payment_id,
        razorpay_order_id
      );

      res.json({ success: true });
      return;
    } catch (error) {
      console.error("Razorpay verification error:", error);
      res.status(500).json({ success: false });
      return;
    }
  }
);

router.get(
  "/subscription/:userId",
  async (req: express.Request, res: express.Response) => {
    try {
      const subscription = await prismaClient.subscription.findFirst({
        where: {
          userId: req.params.userId,
        },
        orderBy: {
          createdAt: "desc",
        },
        select: {
          plan: true,
          createdAt: true,
        },
      });

      res.json({
        subscription: subscription || null,
      });
      return;
    } catch (error) {
      console.error("Error fetching subscription:", error);
      res.status(500).json({ message: "Error fetching subscription status" });
      return;
    }
  }
);

router.get(
  "/credits/:userId",
  async (req: express.Request, res: express.Response) => {
    try {
      const userCredit = await prismaClient.userCredit.findUnique({
        where: {
          userId: req.params.userId,
        },
        select: {
          amount: true,
        },
      });

      res.json({
        credits: userCredit?.amount || 0,
      });
      return;
    } catch (error) {
      console.error("Error fetching credits:", error);
      res.status(500).json({ message: "Error fetching credits" });
      return;
    }
  }
);

// Add this route to get user credits
router.get(
  "/credits",
  authMiddleware,
  async (req: express.Request, res: express.Response) => {
    try {
      if (!req.userId) {
        res.status(401).json({ message: "Unauthorized" });
        return;
      }

      const userCredit = await prismaClient.userCredit.findUnique({
        where: {
          userId: req.userId,
        },
        select: {
          amount: true,
          updatedAt: true,
        },
      });

      res.json({
        credits: userCredit?.amount || 0,
        lastUpdated: userCredit?.updatedAt || null,
      });
      return;
    } catch (error) {
      console.error("Error fetching credits:", error);
      res.status(500).json({
        message: "Error fetching credits",
        details: error instanceof Error ? error.message : "Unknown error",
      });
      return;
    }
  }
);

// Add Stripe webhook handler
router.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];

    try {
      if (!sig) throw new Error("No Stripe signature found");

      const event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET!
      );

      console.log("Webhook event received:", event.type);

      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object as Stripe.Checkout.Session;
          const userId = session.metadata?.userId;
          const plan = session.metadata?.plan as PlanType;

          if (!userId || !plan) {
            throw new Error("Missing metadata in session");
          }

          console.log("Processing successful payment:", {
            userId,
            plan,
            sessionId: session.id,
          });

          await createSubscriptionRecord(
            userId,
            plan,
            session.payment_intent as string,
            session.id
          );

          console.log("Successfully processed payment and added credits");
          break;
        }
      }

      res.json({ received: true });
    } catch (error) {
      console.error("Webhook error:", error);
      res
        .status(400)
        .send(
          `Webhook Error: ${error instanceof Error ? error.message : "Unknown error"}`
        );
    }
  }
);

// Add this new verification endpoint
router.post("/verify", async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      res.status(400).json({ message: "Session ID is required" });
      return;
    }

    // Verify the payment session
    const isValid = await verifyStripePayment(sessionId);

    if (isValid) {
      res.json({ success: true });
      return;
    } else {
      res.status(400).json({ message: "Payment verification failed" });
      return;
    }
  } catch (error) {
    console.error("Payment verification error:", error);
    res.status(500).json({
      message: "Error verifying payment",
      details: error instanceof Error ? error.message : "Unknown error",
    });
    return;
  }
});

export default router;
