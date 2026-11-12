package app.agentero.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeImportFilesTest {
    @Test fun acceptsOnlyBoundedContentUrisWithAnAuthority() {
        assertTrue(NativeImportFilePolicy.validUri("content://provider/document/opaque%3A123"))
        assertTrue(NativeImportFilePolicy.validUri("content://provider/tree/folder/document/a%20b.pdf"))
        val prefix = "content://provider/"
        assertTrue(NativeImportFilePolicy.validUri(prefix + "x".repeat(32768 - prefix.length)))
        listOf("", "file:///private/source.pdf", "https://provider/a", "content:/a", "content:///a",
            "content://", "content:opaque", "content://provider/a b", "content://provider/\nfile",
            prefix + "x".repeat(32769 - prefix.length)).forEach {
            assertFalse(it, NativeImportFilePolicy.validUri(it))
        }
    }

    @Test fun keepsProviderBasenamesIncludingUnicodeAndPdfExtension() {
        assertEquals("研究 🧪.pdf", NativeImportFilePolicy.displayName { "研究 🧪.pdf" })
        assertEquals("paper.PDF", NativeImportFilePolicy.displayName { "paper.PDF" })
    }

    @Test fun trimsOrdinarySurroundingWhitespaceWithoutChangingTheBasename() {
        assertEquals("My paper.pdf", NativeImportFilePolicy.displayName { "  My paper.pdf  " })
    }

    @Test fun missingBlankAndDotNamesFallBackWithoutInventingAMetadataTitle() {
        listOf(null, "", " ", ".", "..", "  .. ").forEach {
            assertNull(NativeImportFilePolicy.displayName { it })
        }
    }

    @Test fun namesCannotContainPathsOrUriAuthorities() {
        listOf("folder/paper.pdf", "folder\\paper.pdf", "/paper.pdf", "content://provider/paper.pdf").forEach {
            assertNull(NativeImportFilePolicy.displayName { it })
        }
    }

    @Test fun controlsAndInvisibleFormattingCannotBecomeNames() {
        listOf("paper\u0000.pdf", "paper\n.pdf", "\tpaper.pdf", "paper\u007f.pdf", "paper\u202e.pdf").forEach {
            assertNull(NativeImportFilePolicy.displayName { it })
        }
    }

    @Test fun namesAreBoundedTo512UnicodeCodePointsWithoutTruncatingThem() {
        val maximum = "🧪".repeat(512)
        assertEquals(maximum, NativeImportFilePolicy.displayName { maximum })
        assertNull(NativeImportFilePolicy.displayName { maximum + "x" })
        assertNull(NativeImportFilePolicy.displayName { "x".repeat(513) })
    }

    @Test fun metadataFailureDoesNotPreventDescriptorOwnershipTransfer() {
        val steps = mutableListOf<String>()
        NativeImportFilePolicy.transfer(
            descriptor = { 41 },
            detach = { steps.add("detach"); 41 },
            closeWrapper = { steps.add("close-wrapper") },
            closeDetached = { steps.add("close-detached") },
            prepare = { fd ->
                val name = NativeImportFilePolicy.displayName { throw SecurityException("provider metadata unavailable") }
                assertNull(name)
                fd to name
            },
            deliver = { response ->
                assertEquals(41 to null, response)
                steps.add("deliver")
            },
        )
        assertEquals(listOf("detach", "close-wrapper", "deliver"), steps)
    }

    private class Descriptor {
        val steps = mutableListOf<String>()
        var prepareFailure = false
        var detachFailure = false
        var wrapperFailure = false
        var deliveryFailure = false
        var fd = 41
        var detachedFd = 41

        fun transfer() = NativeImportFilePolicy.transfer(
            descriptor = { steps.add("descriptor"); fd },
            prepare = {
                steps.add("prepare:$it")
                if (prepareFailure) error("prepare")
                "fd:$it"
            },
            detach = {
                steps.add("detach")
                if (detachFailure) error("detach")
                detachedFd
            },
            closeWrapper = {
                steps.add("close-wrapper")
                if (wrapperFailure) error("wrapper")
            },
            closeDetached = { steps.add("close-detached:$it") },
            deliver = {
                steps.add("deliver:$it")
                if (deliveryFailure) error("delivery")
            },
        )
    }

    @Test fun preparesBeforeDetachingAndTransfersExactlyOnceWithoutClosingRustsFd() {
        val descriptor = Descriptor()
        descriptor.transfer()
        assertEquals(listOf("descriptor", "prepare:41", "detach", "close-wrapper", "deliver:fd:41"), descriptor.steps)
    }

    @Test fun failedResponsePreparationClosesTheStillOwnedWrapperWithoutDetaching() {
        val descriptor = Descriptor().apply { prepareFailure = true }
        assertThrows(IllegalStateException::class.java) { descriptor.transfer() }
        assertEquals(listOf("descriptor", "prepare:41", "close-wrapper"), descriptor.steps)
    }

    @Test fun failedDetachClosesWrapperButDoesNotGuessAnOwnedRawFd() {
        val descriptor = Descriptor().apply { detachFailure = true }
        assertThrows(IllegalStateException::class.java) { descriptor.transfer() }
        assertEquals(listOf("descriptor", "prepare:41", "detach", "close-wrapper"), descriptor.steps)
    }

    @Test fun definitiveFailureAfterDetachBeforeDeliveryClosesRawFdExactlyOnce() {
        val descriptor = Descriptor().apply { wrapperFailure = true }
        assertThrows(IllegalStateException::class.java) { descriptor.transfer() }
        assertEquals(listOf("descriptor", "prepare:41", "detach", "close-wrapper", "close-detached:41"), descriptor.steps)
    }

    @Test fun uncertainDeliveryFailureCannotCloseADescriptorRustMayAlreadyHaveReused() {
        val descriptor = Descriptor().apply { deliveryFailure = true }
        assertThrows(IllegalStateException::class.java) { descriptor.transfer() }
        assertEquals(listOf("descriptor", "prepare:41", "detach", "close-wrapper", "deliver:fd:41"), descriptor.steps)
    }

    @Test fun invalidDescriptorNeverDetachesOrDeliversAndUnexpectedDetachedNumberIsClosed() {
        val invalid = Descriptor().apply { fd = -1 }
        assertThrows(IllegalStateException::class.java) { invalid.transfer() }
        assertEquals(listOf("descriptor", "close-wrapper"), invalid.steps)
        val mismatch = Descriptor().apply { detachedFd = 42 }
        assertThrows(IllegalStateException::class.java) { mismatch.transfer() }
        assertEquals(listOf("descriptor", "prepare:41", "detach", "close-wrapper", "close-detached:42"), mismatch.steps)
    }
}
