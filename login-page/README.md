# App login page (for Elliott or your Webflow person)

The yogaudio app opens a page on yogaudio.com so members can log in with their normal website login. Once they are logged in, the page sends them back to the app. You build this page once in Webflow.

## Steps

1. In Webflow, create a new page with the URL `/app-login`. Name it "App login".
2. Open Page settings for this page, then SEO, and turn off "Sitemap indexing". Also turn on "Exclude this page from search results" if you see it. Do not add the page to any menu or the site navigation.
3. Do not put the site header and footer on this page if they contain any pricing or "join" links. Use a bare page, or a header and footer without those links. The page must show nothing about prices or joining.
4. Add a login form from Memberstack to the page (the same login form you use elsewhere on the site). Remove every sign-up or join link from this copy of the form. A "forgot password" link may stay.
5. Select the form's wrapper (the box that contains the form) and add a custom attribute: name `data-app-login-form`, value `true`. The page uses this to show the form only when the member is not yet logged in.
6. In Memberstack, turn OFF "redirect after login" for this page, so members are not sent elsewhere and never get back to the app. Set the login form on this page to stay on the same page after login (no redirect). If that option doesn't exist, tell Hau.
7. Add an Embed element to the page and paste in the whole contents of `app-login.html` from this folder. Keep it on the page, outside the form.
8. Set the API address: the address is already filled in at the top of the pasted code: `https://yogaudio-api.shrill-cloud-cf32.workers.dev/auth/code`. Change it only if the API moves to a custom domain.
9. Publish the site. Developer gate: open `/app-login`, then run `typeof window.$memberstackDom` in the browser console; it must print `"object"`. Open `https://www.yogaudio.com/app-login?state=aaaaaaaaaaaaaaaaaaaa&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM` in a browser. A logged-in member is sent straight to `yogaudio://auth` (the browser will say it cannot open that address, which is expected on a computer). A moment later a "Return to the app" link appears under the message. A logged-out visitor sees the login form. Opening `/app-login` with nothing after it shows a plain "This sign-in link is not valid" message.

## For the developer

- The embed assumes Memberstack's script is already installed site-wide and uses its `$memberstackDom` object. The Memberstack calls were checked against the Memberstack DOM docs (see the "verified" comment in `app-login.html`); only the `$memberstackDom` global name still needs confirming on the live page (step 9).
- After sending the member to the app, the page shows a "Return to the app" link 1.5 s later, pointing at the same `yogaudio://auth?...` address. Some phone browsers only open the app from a tap, so this link is the fallback. Leave it in place.
- The callback `yogaudio://auth` is a constant in the script, never read from the address, so the page cannot be used as an open redirect.
- The API's `LOGIN_PAGE_ORIGIN` must be `https://www.yogaudio.com` (the page posts to the API from there).
- Locally, `npm run fakes` serves `/app-login` on http://localhost:8788 using the same handoff script from `app-login.html`; only the token source is replaced by two buttons.
