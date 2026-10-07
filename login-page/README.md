# App login page (for Elliott or your Webflow person)

The yogaudio app opens a page on yogaudio.com so members can log in with their normal website login. Once they are logged in, the page sends them back to the app. You build this page once in Webflow.

## Steps

1. In Webflow, create a new page with the URL `/app-login`. Name it "App login".
2. Open Page settings for this page, then SEO, and turn off "Sitemap indexing". Also turn on "Exclude this page from search results" if you see it. Do not add the page to any menu or the site navigation.
3. Do not put the site header and footer on this page if they contain any pricing or "join" links. Use a bare page, or a header and footer without those links. The page must show nothing about prices or joining.
4. Add a login form from Memberstack to the page (the same login form you use elsewhere on the site). Remove every sign-up or join link from this copy of the form. A "forgot password" link may stay.
5. Select the form's wrapper (the box that contains the form) and add a custom attribute: name `data-app-login-form`, value `true`. The page uses this to show the form only when the member is not yet logged in.
6. In Memberstack, turn OFF "redirect after login" for this page, so members are not sent elsewhere and never get back to the app. Confirm in Task 10: Memberstack may only offer a global or per-plan redirect setting. If so, Hau will advise what to do, so do not get stuck on this step.
7. Add an Embed element to the page and paste in the whole contents of `app-login.html` from this folder. Keep it on the page, outside the form.
8. Set the API address: at the top of the pasted code, change the line `window.YOGAUDIO_CODE_URL = "https://API_HOST_SET_IN_TASK_10/auth/code";` to the real address of the yogaudio API, ending in `/auth/code`. This is the only line you ever need to edit.
9. Publish the site. Open `https://www.yogaudio.com/app-login?state=aaaaaaaaaaaaaaaaaaaa&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM` in a browser. A logged-in member is sent straight to `yogaudio://auth` (the browser will say it cannot open that address, which is expected on a computer). A logged-out visitor sees the login form. Opening `/app-login` with nothing after it shows a plain "This sign-in link is not valid" message.

## For the developer

- The embed assumes Memberstack's script is already installed site-wide and uses its `$memberstackDom` object. The Memberstack calls are marked "verify in Task 10" in `app-login.html`.
- The callback `yogaudio://auth` is a constant in the script, never read from the address, so the page cannot be used as an open redirect.
- The API's `LOGIN_PAGE_ORIGIN` must be `https://www.yogaudio.com` (the page posts to the API from there).
- Locally, `npm run fakes` serves `/app-login` on http://localhost:8788 using the same handoff script from `app-login.html`; only the token source is replaced by two buttons.
