--
-- PostgreSQL database dump
--

\restrict cQlmyPApcErUs679Jqg9MlUadl4Gy8SLjbJ7iqdjPsy2f7J6Ig5gYWrIS4AWtIC

-- Dumped from database version 14.23 (d428d47)
-- Dumped by pg_dump version 14.21 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: EventCategory; Type: TYPE; Schema: public; Owner: neondb_owner
--

CREATE TYPE public."EventCategory" AS ENUM (
    'CONCERT',
    'FESTIVAL',
    'CONFERENCE',
    'SPORT',
    'CULTURAL',
    'THEATRE',
    'OTHER'
);


ALTER TYPE public."EventCategory" OWNER TO neondb_owner;

--
-- Name: EventStatus; Type: TYPE; Schema: public; Owner: neondb_owner
--

CREATE TYPE public."EventStatus" AS ENUM (
    'DRAFT',
    'PUBLISHED',
    'CLOSED',
    'CANCELLED',
    'PENDING_REVIEW',
    'REJECTED'
);


ALTER TYPE public."EventStatus" OWNER TO neondb_owner;

--
-- Name: MediaType; Type: TYPE; Schema: public; Owner: neondb_owner
--

CREATE TYPE public."MediaType" AS ENUM (
    'IMAGE',
    'VIDEO',
    'DOCUMENT',
    'DESIGN',
    'OTHER'
);


ALTER TYPE public."MediaType" OWNER TO neondb_owner;

--
-- Name: PaymentStatus; Type: TYPE; Schema: public; Owner: neondb_owner
--

CREATE TYPE public."PaymentStatus" AS ENUM (
    'PENDING',
    'PAID',
    'FAILED',
    'REFUNDED'
);


ALTER TYPE public."PaymentStatus" OWNER TO neondb_owner;

--
-- Name: QRStatus; Type: TYPE; Schema: public; Owner: neondb_owner
--

CREATE TYPE public."QRStatus" AS ENUM (
    'UNUSED',
    'USED',
    'CANCELLED'
);


ALTER TYPE public."QRStatus" OWNER TO neondb_owner;

--
-- Name: Role; Type: TYPE; Schema: public; Owner: neondb_owner
--

CREATE TYPE public."Role" AS ENUM (
    'ADMIN',
    'AGENT'
);


ALTER TYPE public."Role" OWNER TO neondb_owner;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: Agent; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public."Agent" (
    id text NOT NULL,
    "userId" text,
    active boolean DEFAULT true NOT NULL,
    code text NOT NULL,
    "eventId" text NOT NULL,
    firstname text NOT NULL,
    lastname text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "usedAt" timestamp(3) without time zone
);


ALTER TABLE public."Agent" OWNER TO neondb_owner;

--
-- Name: Event; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public."Event" (
    id text NOT NULL,
    title text NOT NULL,
    description text NOT NULL,
    "startDate" timestamp(3) without time zone NOT NULL,
    "endDate" timestamp(3) without time zone NOT NULL,
    location text NOT NULL,
    "gpsLat" double precision,
    "gpsLng" double precision,
    "purchaseDeadline" timestamp(3) without time zone NOT NULL,
    "dressCode" text,
    category public."EventCategory" NOT NULL,
    status public."EventStatus" DEFAULT 'DRAFT'::public."EventStatus" NOT NULL,
    "termsAccepted" boolean DEFAULT false NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "createdById" text NOT NULL,
    "reviewedAt" timestamp(3) without time zone,
    "totalCapacity" integer
);


ALTER TABLE public."Event" OWNER TO neondb_owner;

--
-- Name: EventMedia; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public."EventMedia" (
    id text NOT NULL,
    "eventId" text NOT NULL,
    url text NOT NULL,
    "fileKey" text NOT NULL,
    "fileName" text NOT NULL,
    "mimeType" text NOT NULL,
    "sizeBytes" integer NOT NULL,
    "mediaType" public."MediaType" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "isPoster" boolean DEFAULT false NOT NULL
);


ALTER TABLE public."EventMedia" OWNER TO neondb_owner;

--
-- Name: EventParticipant; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public."EventParticipant" (
    id text NOT NULL,
    "joinedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "eventId" text NOT NULL,
    "UserId" text NOT NULL
);


ALTER TABLE public."EventParticipant" OWNER TO neondb_owner;

--
-- Name: Order; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public."Order" (
    id text NOT NULL,
    "ticketCategoryId" text NOT NULL,
    quantity integer NOT NULL,
    "unitPrice" double precision NOT NULL,
    "totalAmount" double precision NOT NULL,
    "platformFee" double precision NOT NULL,
    "organizerAmount" double precision NOT NULL,
    "paymentStatus" public."PaymentStatus" DEFAULT 'PENDING'::public."PaymentStatus" NOT NULL,
    "paymentRef" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "userId" text NOT NULL
);


ALTER TABLE public."Order" OWNER TO neondb_owner;

--
-- Name: OtpVerification; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public."OtpVerification" (
    id text NOT NULL,
    "expiresAt" timestamp(3) without time zone NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "userId" text,
    attempts integer DEFAULT 0 NOT NULL,
    code text NOT NULL,
    identifier text NOT NULL,
    used boolean DEFAULT false NOT NULL,
    "blockedUntil" timestamp(3) without time zone
);


ALTER TABLE public."OtpVerification" OWNER TO neondb_owner;

--
-- Name: Ticket; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public."Ticket" (
    id text NOT NULL,
    "orderId" text NOT NULL,
    "ticketCategoryId" text NOT NULL,
    "qrToken" text NOT NULL,
    "qrStatus" public."QRStatus" DEFAULT 'UNUSED'::public."QRStatus" NOT NULL,
    "scannedAt" timestamp(3) without time zone,
    "scannedByAgentId" text,
    "expiresAt" timestamp(3) without time zone NOT NULL,
    "pdfUrl" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public."Ticket" OWNER TO neondb_owner;

--
-- Name: TicketCategory; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public."TicketCategory" (
    id text NOT NULL,
    "eventId" text NOT NULL,
    name text NOT NULL,
    price double precision NOT NULL,
    "totalStock" integer,
    "soldCount" integer DEFAULT 0 NOT NULL,
    "maxPerOrder" integer DEFAULT 10 NOT NULL,
    benefits text,
    "ticketDesignUrl" text NOT NULL
);


ALTER TABLE public."TicketCategory" OWNER TO neondb_owner;

--
-- Name: UsedToken; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public."UsedToken" (
    jti text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public."UsedToken" OWNER TO neondb_owner;

--
-- Name: User; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public."User" (
    id text NOT NULL,
    email text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    firstname text,
    lastname text,
    role public."Role" NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "emailVerified" boolean DEFAULT false NOT NULL,
    phone text,
    "phoneVerified" boolean DEFAULT false NOT NULL,
    "hashedPassword" text,
    "profileUpdateCount" integer DEFAULT 0 NOT NULL,
    "profileUpdateMonth" integer DEFAULT 0 NOT NULL,
    "profileUpdateYear" integer DEFAULT 0 NOT NULL,
    "profileUpdatedAt" timestamp(3) without time zone,
    "avatarUrl" text,
    "deletionRequestedAt" timestamp(3) without time zone,
    "isValid" boolean DEFAULT true NOT NULL
);


ALTER TABLE public."User" OWNER TO neondb_owner;

--
-- Name: _prisma_migrations; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public._prisma_migrations (
    id character varying(36) NOT NULL,
    checksum character varying(64) NOT NULL,
    finished_at timestamp with time zone,
    migration_name character varying(255) NOT NULL,
    logs text,
    rolled_back_at timestamp with time zone,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    applied_steps_count integer DEFAULT 0 NOT NULL
);


ALTER TABLE public._prisma_migrations OWNER TO neondb_owner;

--
-- Data for Name: Agent; Type: TABLE DATA; Schema: public; Owner: neondb_owner
--

COPY public."Agent" (id, "userId", active, code, "eventId", firstname, lastname, "createdAt", "usedAt") FROM stdin;
\.


--
-- Data for Name: Event; Type: TABLE DATA; Schema: public; Owner: neondb_owner
--

COPY public."Event" (id, title, description, "startDate", "endDate", location, "gpsLat", "gpsLng", "purchaseDeadline", "dressCode", category, status, "termsAccepted", "createdAt", "createdById", "reviewedAt", "totalCapacity") FROM stdin;
\.


--
-- Data for Name: EventMedia; Type: TABLE DATA; Schema: public; Owner: neondb_owner
--

COPY public."EventMedia" (id, "eventId", url, "fileKey", "fileName", "mimeType", "sizeBytes", "mediaType", "createdAt", "isPoster") FROM stdin;
\.


--
-- Data for Name: EventParticipant; Type: TABLE DATA; Schema: public; Owner: neondb_owner
--

COPY public."EventParticipant" (id, "joinedAt", "eventId", "UserId") FROM stdin;
\.


--
-- Data for Name: Order; Type: TABLE DATA; Schema: public; Owner: neondb_owner
--

COPY public."Order" (id, "ticketCategoryId", quantity, "unitPrice", "totalAmount", "platformFee", "organizerAmount", "paymentStatus", "paymentRef", "createdAt", "userId") FROM stdin;
\.


--
-- Data for Name: OtpVerification; Type: TABLE DATA; Schema: public; Owner: neondb_owner
--

COPY public."OtpVerification" (id, "expiresAt", "createdAt", "userId", attempts, code, identifier, used, "blockedUntil") FROM stdin;
8bb5417e-771c-473a-85f6-318d76365c5e	2026-07-07 17:13:27.207	2026-07-07 17:08:28.241	\N	0	379766	samuelbakumbane0@gmail.com	t	\N
9a824d07-2c87-4311-ad4f-49f559de0801	2026-07-07 19:17:55.272	2026-07-07 19:12:56.254	\N	0	966995	samuelbakumbane0@gmail.com	t	\N
bb3ed6bd-34c6-43d3-ab16-17c16d79c8b1	2026-07-07 19:18:27.643	2026-07-07 19:13:28.278	\N	0	265025	samuelbakumbane0@gmail.com	t	\N
2a33694e-24f5-4db3-9b79-fef8911d8cf2	2026-07-07 19:19:49.048	2026-07-07 19:14:49.698	\N	0	882501	samuelbakumbane0@gmail.com	t	\N
3df43382-8c9f-4361-bf07-659419165a84	2026-07-07 19:22:26.48	2026-07-07 19:17:27.77	\N	0	318519	samuelbakumbane0@gmail.com	t	\N
8ad48d03-5d98-4f3e-87f5-e55019aa2022	2026-07-07 19:34:36.366	2026-07-07 19:29:37.398	\N	0	248187	samuelbakumbane0@gmail.com	f	\N
\.


--
-- Data for Name: Ticket; Type: TABLE DATA; Schema: public; Owner: neondb_owner
--

COPY public."Ticket" (id, "orderId", "ticketCategoryId", "qrToken", "qrStatus", "scannedAt", "scannedByAgentId", "expiresAt", "pdfUrl", "createdAt") FROM stdin;
\.


--
-- Data for Name: TicketCategory; Type: TABLE DATA; Schema: public; Owner: neondb_owner
--

COPY public."TicketCategory" (id, "eventId", name, price, "totalStock", "soldCount", "maxPerOrder", benefits, "ticketDesignUrl") FROM stdin;
\.


--
-- Data for Name: UsedToken; Type: TABLE DATA; Schema: public; Owner: neondb_owner
--

COPY public."UsedToken" (jti, "createdAt") FROM stdin;
4d424f39-7b64-440b-b070-5f677177498c	2026-07-07 17:09:42.287
32fcc8e2-c71d-4f34-aaef-82adf1d8cbf3	2026-07-07 19:18:29.567
\.


--
-- Data for Name: User; Type: TABLE DATA; Schema: public; Owner: neondb_owner
--

COPY public."User" (id, email, "createdAt", firstname, lastname, role, "updatedAt", "emailVerified", phone, "phoneVerified", "hashedPassword", "profileUpdateCount", "profileUpdateMonth", "profileUpdateYear", "profileUpdatedAt", "avatarUrl", "deletionRequestedAt", "isValid") FROM stdin;
76e0b947-c06a-436d-b090-93b11e7b650c	samuelbakumbane0@gmail.com	2026-07-07 19:18:29.567	Samy	Jammal	ADMIN	2026-07-07 19:18:29.567	t	\N	f	$2b$10$chDUEjhJXd2sIlq8CaGc.OJXW7yIH1UI4O9AL186HSQkxe5jY5cNG	0	0	0	\N	\N	\N	t
\.


--
-- Data for Name: _prisma_migrations; Type: TABLE DATA; Schema: public; Owner: neondb_owner
--

COPY public._prisma_migrations (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count) FROM stdin;
1836b3be-976f-4a30-ba17-d0b94ff5c0ca	74321ef4af21dd277012df04272490dac49483b673162e05f491e8db020c4494	2026-06-30 15:31:22.767075+00	20260508210810_init	\N	\N	2026-06-30 15:31:22.719992+00	1
126ad43a-aa3b-48b6-a2df-9392b712beb1	122cfd98a90416f45c83ba81862222d3bdfe67032995440e8c414b271868f226	2026-06-30 15:31:23.161292+00	20260615124453_add_avatar_url	\N	\N	2026-06-30 15:31:23.151336+00	1
3b1ddd8d-a98e-4327-b480-195414ebb55d	d0c7155a708b9c8190212c0b901d03b07998a553d5575e9dccd0fe675b0531ba	2026-06-30 15:31:22.912355+00	20260509235736_migration	\N	\N	2026-06-30 15:31:22.771491+00	1
b8131450-6198-424d-8c2f-0bbc4bf2a682	f034bf7f388eb362bfccd66bbca87ea1138c60be03257cfb808678a2f39c775b	2026-06-30 15:31:22.926224+00	20260514183231_second	\N	\N	2026-06-30 15:31:22.915996+00	1
d7c1ecb0-f4a2-4f60-9ac8-2bbcd89e8e58	75c3e8c0305560aa4db82c63a4fae8036c62ce0403f2fcf9c9877dad16f8628e	2026-06-30 15:31:22.943381+00	20260517195608_fix_agents_relation	\N	\N	2026-06-30 15:31:22.930334+00	1
ee3d60fb-f76d-4192-8c6a-e1c47a48284e	f5f156e99d52cb2fd119902774fa51e4f59a0781e7ad8aeab19cb85749510413	2026-06-30 15:31:23.175113+00	20260616190912_add_blocked_until_to_otp	\N	\N	2026-06-30 15:31:23.164909+00	1
ca455555-2503-42cc-8202-a9ba7c1c7482	a7294cc6ca58b80b0b6f86a6cb2e8c5256238a4ab981b7f17a6585459c88ea92	2026-06-30 15:31:22.969541+00	20260518222008_add_otp_verification	\N	\N	2026-06-30 15:31:22.947287+00	1
ac8d52de-9dd0-4659-a1a5-230ec69ff1bb	01baa06e3440df93a9fafcb9559b20ccf79ab06e978f2d42995d675d927fd895	2026-06-30 15:31:22.986238+00	20260518222512_fix_bug	\N	\N	2026-06-30 15:31:22.973258+00	1
eb2dcb35-0967-4b06-bfc2-af3131de66ff	637b37653fb4b202a21c0023f8f70944e605c3cb31fb5b1317938ef86eb5b66e	2026-06-30 15:31:23.043795+00	20260519232903_ajustement	\N	\N	2026-06-30 15:31:22.990519+00	1
cb47d1f0-22d3-46f4-8d67-faa220e0acb2	b3943853d603d71e215a76dfd73c44dcb6c14d7b7b1929bfbe8a8d8dce4fbb15	2026-06-30 15:31:23.188702+00	20260618005300_add_soft_delete_to_user	\N	\N	2026-06-30 15:31:23.178674+00	1
a0317ad5-446f-4f6c-9c34-b13c3fa64aaf	e30a146e82fea2972a11a792007dd41f873f9c63d74d36a672dfba5f3f577e30	2026-06-30 15:31:23.05984+00	20260530130608_update_otp_verification_add_email	\N	\N	2026-06-30 15:31:23.047454+00	1
de435db3-9975-44d3-b4ac-35ab5492310d	8ff13d76179b2b893f8e4deaecea8cf9c1337d10eb2b499f34582dd84a3b3a0a	2026-06-30 15:31:23.079349+00	20260602200049_add_used_token	\N	\N	2026-06-30 15:31:23.063467+00	1
3c2733c6-9e61-4c46-b984-30b9cfc0023a	a11ca7a2718d4f3b9e41db60da0052a3a1cc8b042d329004a7bfbc45cdc2fb1f	2026-06-30 15:31:23.103654+00	20260605112837_refactor_otp_verification	\N	\N	2026-06-30 15:31:23.082913+00	1
f78891bf-97a6-40a1-8c6f-02daa193472d	ae9e1ed8496e3d82336bdf29719dc5ba5ca1f9bc0a405520b0ad0cfb4ff3aac9	2026-06-30 15:31:23.203021+00	20260625133253_event_creation_moderation	\N	\N	2026-06-30 15:31:23.192453+00	1
d620a44b-3534-4d51-810a-5963cf515789	7e7e97cd0779c43a7ec945fcaae83b4022f8e6659e41b461811c63e3ad487296	2026-06-30 15:31:23.116858+00	20260605113313_modify_otpverification	\N	\N	2026-06-30 15:31:23.107166+00	1
f6792933-cff3-4ae7-86ab-ebb4660bdefe	d8a30906f4f2cc9c173922580c1f3946f7c507befff0a0d5b535db5e8c817e0c	2026-06-30 15:31:23.130975+00	20260605225347_add_used_to_otp	\N	\N	2026-06-30 15:31:23.120921+00	1
5426ae4d-fec7-476f-b9fd-ff183d750906	bab060188c38f55b76c71dc08d48ea2ebe24a4b59df8b1702dd63c836c2c6cd2	2026-06-30 15:31:23.147054+00	20260609193414_add_profile_update_tracking	\N	\N	2026-06-30 15:31:23.134838+00	1
82408696-2693-4b05-94e2-df64fbef816a	47a6a601e1b9af3552e617ebadb5e02990a4aa4d87db9b9a69a69819e0e5cd95	2026-07-02 14:14:30.029739+00	20260701125745_event_ticket_stock_capacity	\N	\N	2026-07-02 14:14:28.599665+00	1
\.


--
-- Name: Agent Agent_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public."Agent"
    ADD CONSTRAINT "Agent_pkey" PRIMARY KEY (id);


--
-- Name: EventMedia EventMedia_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public."EventMedia"
    ADD CONSTRAINT "EventMedia_pkey" PRIMARY KEY (id);


--
-- Name: EventParticipant EventParticipant_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public."EventParticipant"
    ADD CONSTRAINT "EventParticipant_pkey" PRIMARY KEY (id);


--
-- Name: Event Event_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public."Event"
    ADD CONSTRAINT "Event_pkey" PRIMARY KEY (id);


--
-- Name: Order Order_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public."Order"
    ADD CONSTRAINT "Order_pkey" PRIMARY KEY (id);


--
-- Name: OtpVerification OtpVerification_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public."OtpVerification"
    ADD CONSTRAINT "OtpVerification_pkey" PRIMARY KEY (id);


--
-- Name: TicketCategory TicketCategory_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public."TicketCategory"
    ADD CONSTRAINT "TicketCategory_pkey" PRIMARY KEY (id);


--
-- Name: Ticket Ticket_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public."Ticket"
    ADD CONSTRAINT "Ticket_pkey" PRIMARY KEY (id);


--
-- Name: UsedToken UsedToken_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public."UsedToken"
    ADD CONSTRAINT "UsedToken_pkey" PRIMARY KEY (jti);


--
-- Name: User User_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public."User"
    ADD CONSTRAINT "User_pkey" PRIMARY KEY (id);


--
-- Name: _prisma_migrations _prisma_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public._prisma_migrations
    ADD CONSTRAINT _prisma_migrations_pkey PRIMARY KEY (id);


--
-- Name: Agent_code_key; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE UNIQUE INDEX "Agent_code_key" ON public."Agent" USING btree (code);


--
-- Name: EventParticipant_eventId_UserId_key; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE UNIQUE INDEX "EventParticipant_eventId_UserId_key" ON public."EventParticipant" USING btree ("eventId", "UserId");


--
-- Name: Ticket_expiresAt_idx; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX "Ticket_expiresAt_idx" ON public."Ticket" USING btree ("expiresAt");


--
-- Name: Ticket_qrToken_idx; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX "Ticket_qrToken_idx" ON public."Ticket" USING btree ("qrToken");


--
-- Name: Ticket_qrToken_key; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE UNIQUE INDEX "Ticket_qrToken_key" ON public."Ticket" USING btree ("qrToken");


--
-- Name: User_email_key; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE UNIQUE INDEX "User_email_key" ON public."User" USING btree (email);


--
-- Name: User_phone_key; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE UNIQUE INDEX "User_phone_key" ON public."User" USING btree (phone);


--
-- Name: Agent Agent_eventId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public."Agent"
    ADD CONSTRAINT "Agent_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES public."Event"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: Agent Agent_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public."Agent"
    ADD CONSTRAINT "Agent_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: EventMedia EventMedia_eventId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public."EventMedia"
    ADD CONSTRAINT "EventMedia_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES public."Event"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: EventParticipant EventParticipant_UserId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public."EventParticipant"
    ADD CONSTRAINT "EventParticipant_UserId_fkey" FOREIGN KEY ("UserId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: EventParticipant EventParticipant_eventId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public."EventParticipant"
    ADD CONSTRAINT "EventParticipant_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES public."Event"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: Event Event_createdById_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public."Event"
    ADD CONSTRAINT "Event_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: Order Order_ticketCategoryId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public."Order"
    ADD CONSTRAINT "Order_ticketCategoryId_fkey" FOREIGN KEY ("ticketCategoryId") REFERENCES public."TicketCategory"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: Order Order_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public."Order"
    ADD CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: OtpVerification OtpVerification_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public."OtpVerification"
    ADD CONSTRAINT "OtpVerification_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: TicketCategory TicketCategory_eventId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public."TicketCategory"
    ADD CONSTRAINT "TicketCategory_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES public."Event"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: Ticket Ticket_orderId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public."Ticket"
    ADD CONSTRAINT "Ticket_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES public."Order"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: Ticket Ticket_ticketCategoryId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public."Ticket"
    ADD CONSTRAINT "Ticket_ticketCategoryId_fkey" FOREIGN KEY ("ticketCategoryId") REFERENCES public."TicketCategory"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: neondb_owner
--

REVOKE ALL ON SCHEMA public FROM cloud_admin;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT ALL ON SCHEMA public TO neondb_owner;
GRANT ALL ON SCHEMA public TO PUBLIC;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: cloud_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE cloud_admin IN SCHEMA public GRANT ALL ON SEQUENCES  TO neon_superuser WITH GRANT OPTION;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: cloud_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE cloud_admin IN SCHEMA public GRANT ALL ON TABLES  TO neon_superuser WITH GRANT OPTION;


--
-- PostgreSQL database dump complete
--

\unrestrict cQlmyPApcErUs679Jqg9MlUadl4Gy8SLjbJ7iqdjPsy2f7J6Ig5gYWrIS4AWtIC

