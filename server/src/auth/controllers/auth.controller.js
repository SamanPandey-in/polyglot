import jwt from 'jsonwebtoken';

const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';

/**
 * BUG 1 FIX: sameSite must be 'none' in production.
 *
 * Vercel (frontend) and Render (backend) are DIFFERENT domains — not subdomains.
 * With sameSite:'lax' the browser refuses to send the JWT cookie on cross-origin
 * requests, so every authenticated API call returns 401 silently.
 *
 * Rules:
 *   - sameSite:'none' requires secure:true (HTTPS only)
 *   - In development (localhost) sameSite:'lax' is fine — both run on localhost
 */
function buildCookieOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure:   isProd,                      // required for sameSite:'none'
    sameSite: isProd ? 'none' : 'lax',    // 'none' = cross-origin allowed in production
    maxAge:   7 * 24 * 60 * 60 * 1000,   // 7 days
  };
}

function signToken(user) {
  return jwt.sign(
    {
      id:       user.id,
      username: user.username,
      email:    user.email,
      avatar:   user.avatar,
      role:     user.role,
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' },
  );
}

function setTokenCookie(res, token) {
  res.cookie('token', token, buildCookieOptions());
}

function setGitHubTokenCookie(res, githubToken) {
  if (!githubToken) return;
  res.cookie('github_token', githubToken, buildCookieOptions());
}

export function handleGitHubCallback(req, res) {
  if (!req.user) {
    return res.redirect(`${CLIENT_URL}/login?error=oauth_failed`);
  }

  if (!process.env.JWT_SECRET) {
    return res.redirect(`${CLIENT_URL}/login?error=server_config`);
  }

  const token = signToken(req.user);
  setTokenCookie(res, token);
  setGitHubTokenCookie(res, req.user.githubAccessToken);

  return res.redirect(`${CLIENT_URL}/dashboard`);
}

export function getCurrentUser(req, res) {
  const token =
    req.cookies?.token ||
    req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.json({ data: null });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return res.json({ data: decoded });
  } catch {
    res.clearCookie('token');
    return res.json({ data: null });
  }
}

export function logout(_req, res) {
  res.clearCookie('token');
  res.clearCookie('github_token');
  return res.json({ message: 'Logged out successfully.' });
}
