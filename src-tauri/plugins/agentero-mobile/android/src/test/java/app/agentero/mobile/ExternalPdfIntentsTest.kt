package app.agentero.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ExternalPdfIntentsTest {
    private val uri = "content://document.provider/document/selected"
    private fun accepts(
        action: String? = "android.intent.action.VIEW",
        mime: String? = "application/pdf",
        selected: String? = uri,
        authority: String? = "document.provider",
        clips: List<String?> = emptyList(),
        text: Boolean = false,
        stream: Boolean = false,
        flag: Boolean = true,
        grant: Boolean = true,
    ) = ExternalPdfIntentPolicy.accepts(action, mime, selected, authority, clips, text, stream, flag, grant)

    @Test fun exactPdfViewRequiresOneUriAndAcceptsTheSameGrantTransportClip() {
        assertTrue(accepts())
        assertTrue(accepts(clips = listOf(uri)))
    }

    @Test fun onlyExactViewPdfRoutingCanReachTheNativeMailbox() {
        for (action in listOf(null, "android.intent.action.SEND", "android.intent.action.SEND_MULTIPLE", "org.chromium.arc.intent.action.VIEW")) {
            assertFalse(accepts(action = action))
        }
        for (mime in listOf(null, "text/plain", "application/octet-stream", "application/PDF", "application/pdf; charset=utf-8")) {
            assertFalse(accepts(mime = mime))
        }
    }

    @Test fun privatePathsUserQualifiedAndUnboundedUrisAreRejected() {
        for (selected in listOf(null, "", "file:///private/a.pdf", "https://example.org/a.pdf", "content:///a",
            "content://7@document.provider/a", "content://7%40document.provider/a", "content://document.provider/" + "a".repeat(32768))) {
            assertFalse(accepts(selected = selected))
        }
        assertFalse(accepts(authority = null))
        assertFalse(accepts(authority = ""))
        assertFalse(accepts(authority = "7@document.provider"))
    }

    @Test fun explicitReadFlagAndCurrentOsGrantAreBothRequired() {
        assertFalse(accepts(flag = false))
        assertFalse(accepts(grant = false))
        assertFalse(accepts(flag = false, grant = false))
    }

    @Test fun ambiguousAdditionalNullOrDifferentClipUrisAreRejected() {
        assertFalse(accepts(clips = listOf("content://other/document")))
        assertFalse(accepts(clips = listOf(null)))
        assertFalse(accepts(clips = listOf(uri, uri)))
        assertFalse(accepts(clips = listOf(uri, "content://other/document")))
    }

    @Test fun textAndStreamPayloadsCannotBeReinterpretedAsViewDocuments() {
        assertFalse(accepts(text = true))
        assertFalse(accepts(stream = true))
        assertFalse(accepts(text = true, stream = true))
    }

    @Test fun oneSlotFirstWinsAndClaimReleasesExactlyOnce() {
        val mailbox = ExternalPdfMailbox()
        assertEquals(ExternalPdfMailbox.Admission.ACCEPTED, mailbox.offer(uri))
        assertEquals(ExternalPdfMailbox.Admission.BUSY, mailbox.offer("content://other/document"))
        assertEquals(uri, mailbox.take())
        assertNull(mailbox.take())
        assertEquals(ExternalPdfMailbox.Admission.ACCEPTED, mailbox.offer("content://other/document"))
        assertEquals("content://other/document", mailbox.take())
    }

    @Test fun coldIntentIsReadOnceAndNeitherClaimNorDestroyReplaysIt() {
        val mailbox = ExternalPdfMailbox()
        var reads = 0
        assertEquals(ExternalPdfMailbox.Admission.ACCEPTED, mailbox.captureInitial { reads += 1; uri })
        assertEquals(uri, mailbox.take())
        assertEquals(ExternalPdfMailbox.Admission.IGNORED, mailbox.captureInitial { reads += 1; uri })
        mailbox.clear()
        assertEquals(ExternalPdfMailbox.Admission.IGNORED, mailbox.captureInitial { reads += 1; uri })
        assertEquals(1, reads)
        assertNull(mailbox.take())
    }

    @Test fun warmArrivalBeforeLoadCannotReplayAnOlderColdIntentAfterClaim() {
        val mailbox = ExternalPdfMailbox()
        assertEquals(ExternalPdfMailbox.Admission.ACCEPTED, mailbox.offer(uri))
        assertEquals(uri, mailbox.take())
        var reads = 0
        assertEquals(ExternalPdfMailbox.Admission.IGNORED, mailbox.captureInitial { reads += 1; "content://old/document" })
        assertEquals(0, reads)
        assertNull(mailbox.take())
    }

    @Test fun invalidIntakeDoesNotConsumeTheOneSlotOrReopenAnOldColdIntent() {
        val mailbox = ExternalPdfMailbox()
        assertEquals(ExternalPdfMailbox.Admission.IGNORED, mailbox.captureInitial { null })
        assertEquals(ExternalPdfMailbox.Admission.IGNORED, mailbox.offer(null))
        assertEquals(ExternalPdfMailbox.Admission.ACCEPTED, mailbox.offer(uri))
        mailbox.clear()
        assertNull(mailbox.take())
        assertEquals(ExternalPdfMailbox.Admission.ACCEPTED, mailbox.offer(uri))
    }
}
